// A menu bar app for the two npm release steps that need the maintainer's 2FA:
// trusting the packages before the release push, and approving what CI staged.
// It runs the repository's release scripts with no terminal. npm cannot prompt
// without one, so the app asks for the authenticator code itself and hands it to
// npm in the environment (npm_config_otp), never on a command line and never in the log.
//
//   lf-release                  the menu bar app
//   lf-release --run <action>   runs one action headless and prints what the alert would say
//                               (actions: trust, approve; the code, if any, from LF_RELEASE_HEADLESS_CODE)
import AppKit

let nodeBin = NSHomeDirectory() + "/.nvm/versions/node/v22.23.4/bin"
let pinnedNpm = "npm@11.21.2"
let logURL = URL(fileURLWithPath: NSHomeDirectory() + "/Library/Logs/lf-release.log")

let repositoryPath: String = {
    guard let path = Bundle.main.object(forInfoDictionaryKey: "LFRepositoryPath") as? String else {
        fatalError("Info.plist carries no LFRepositoryPath; build the app with build.sh")
    }
    return path
}()

// MARK: running processes

/// Appends to the log and the in-memory copy from whichever thread npm's output arrives on.
final class OutputSink: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""
    private var partialLine = ""
    private let onLine: (@Sendable (String) -> Void)?

    init(onLine: (@Sendable (String) -> Void)?) { self.onLine = onLine }

    func append(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.lock()
        let chunk = String(decoding: data, as: UTF8.self)
        text += chunk
        appendToLog(data)
        partialLine += chunk
        var lines: [String] = []
        while let newline = partialLine.firstIndex(of: "\n") {
            lines.append(String(partialLine[..<newline]))
            partialLine.removeSubrange(...newline)
        }
        lock.unlock()
        for line in lines { onLine?(line) }
    }

    var output: String {
        lock.lock()
        defer { lock.unlock() }
        return text
    }
}

func appendToLog(_ data: Data) {
    guard let handle = try? FileHandle(forWritingTo: logURL) else { return }
    defer { try? handle.close() }
    _ = try? handle.seekToEnd()
    try? handle.write(contentsOf: data)
}

/// Each action starts a new log file.
func startLog(_ title: String) {
    try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? Data("\(title)\n".utf8).write(to: logURL)
}

struct ProcessResult {
    let status: Int32
    let output: String
}

/// No TTY (stdin is /dev/null), PATH holds the pinned Node. The code is only ever in `extraEnvironment`.
func runProcess(
    _ executable: String,
    _ arguments: [String],
    extraEnvironment: [String: String] = [:],
    onLine: (@Sendable (String) -> Void)? = nil
) async -> ProcessResult {
    appendToLog(Data("\n$ \(([executable] + arguments).joined(separator: " "))\n".utf8))
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.currentDirectoryURL = URL(fileURLWithPath: repositoryPath)
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = "\(nodeBin):/usr/bin:/bin:/usr/sbin:/sbin"
    environment.removeValue(forKey: "npm_config_otp")
    environment.merge(extraEnvironment) { _, new in new }
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe

    let sink = OutputSink(onLine: onLine)
    pipe.fileHandleForReading.readabilityHandler = { handle in sink.append(handle.availableData) }

    return await withCheckedContinuation { continuation in
        process.terminationHandler = { finished in
            pipe.fileHandleForReading.readabilityHandler = nil
            sink.append((try? pipe.fileHandleForReading.readToEnd()) ?? Data())
            continuation.resume(returning: ProcessResult(status: finished.terminationStatus, output: sink.output))
        }
        do {
            try process.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            sink.append(Data("could not start \(executable): \(error)\n".utf8))
            continuation.resume(returning: ProcessResult(status: 127, output: sink.output))
        }
    }
}

func npmArguments(_ rest: [String]) -> [String] { ["-y", pinnedNpm] + rest }

func lastLine(_ output: String) -> String {
    let line = output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty } ?? "no output"
    return line.count > 200 ? String(line.prefix(200)) + "…" : line
}

func mentions(_ output: String, _ pattern: String) -> Bool {
    output.range(of: pattern, options: .regularExpression) != nil
}

// MARK: what the person is shown

enum Outcome {
    case done(String)
    case nothingToDo(String)
    case failed(String)
    case cancelled
    case notSignedIn
}

@MainActor
protocol Prompter {
    func confirmApproval(list: String) async -> Bool
    /// `rejected`: the previous code was refused or had expired. nil: the person cancelled.
    func askCode(rejected: Bool) async -> String?
    func offerSignIn() async -> Bool
    func signInURL(_ url: URL)
    func report(_ summary: String) async
}

@MainActor
final class AlertPrompter: Prompter {
    /// The window to attach alerts to as sheets; nil while it is closed, when alerts stand alone.
    private let sheetWindow: () -> NSWindow?

    init(sheetWindow: @escaping () -> NSWindow?) { self.sheetWindow = sheetWindow }

    private func present(_ alert: NSAlert) async -> NSApplication.ModalResponse {
        NSApp.activate(ignoringOtherApps: true)
        guard let window = sheetWindow() else { return alert.runModal() }
        return await withCheckedContinuation { continuation in
            alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
    }

    func confirmApproval(list: String) async -> Bool {
        let alert = NSAlert()
        alert.messageText = "Approve these staged packages?"
        alert.informativeText = list
        alert.addButton(withTitle: "Approve")
        alert.addButton(withTitle: "Cancel")
        return await present(alert) == .alertFirstButtonReturn
    }

    func askCode(rejected: Bool) async -> String? {
        let alert = NSAlert()
        alert.messageText = rejected ? "npm refused that code" : "Authenticator code"
        alert.informativeText = rejected
            ? "Wait for a fresh code from your authenticator app and enter it."
            : "Enter the current code from your authenticator app."
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        alert.accessoryView = field
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard await present(alert) == .alertFirstButtonReturn else { return nil }
        let code = field.stringValue.filter { !$0.isWhitespace }
        return code.isEmpty ? nil : code
    }

    func offerSignIn() async -> Bool {
        let alert = NSAlert()
        alert.messageText = "npm on this Mac isn't signed in"
        alert.informativeText = "Sign in once; npm then remembers it. The sign-in opens in your browser."
        alert.addButton(withTitle: "Sign in")
        alert.addButton(withTitle: "Cancel")
        return await present(alert) == .alertFirstButtonReturn
    }

    func signInURL(_ url: URL) { NSWorkspace.shared.open(url) }

    func report(_ summary: String) async {
        let alert = NSAlert()
        alert.messageText = summary
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Show log")
        if await present(alert) == .alertSecondButtonReturn { NSWorkspace.shared.open(logURL) }
    }
}

/// Prints what the alerts would say. A code is taken only from LF_RELEASE_HEADLESS_CODE, which also stands for confirming the approval.
@MainActor
final class HeadlessPrompter: Prompter {
    private let code = ProcessInfo.processInfo.environment["LF_RELEASE_HEADLESS_CODE"]

    func confirmApproval(list: String) async -> Bool {
        print("ALERT confirm approval:\n\(list)")
        if code == nil { print("(headless: not confirmed without LF_RELEASE_HEADLESS_CODE)") }
        return code != nil
    }

    func askCode(rejected: Bool) async -> String? {
        print("ALERT ask for authenticator code\(rejected ? " (previous refused)" : "")")
        return rejected ? nil : code
    }

    func offerSignIn() async -> Bool {
        print("ALERT npm on this Mac isn't signed in; button: Sign in (runs `npm login`, URL opened in the browser)")
        return false
    }

    func signInURL(_ url: URL) { print("would open \(url)") }
    func report(_ summary: String) async { print("ALERT \(summary)") }
}

// MARK: the actions

@MainActor
final class Actions {
    private let prompter: Prompter
    private let setStatus: (String) -> Void
    private let node = nodeBin + "/node"
    private let npx = nodeBin + "/npx"

    init(prompter: Prompter, setStatus: @escaping (String) -> Void) {
        self.prompter = prompter
        self.setStatus = setStatus
    }

    private func script(_ name: String) -> String { repositoryPath + "/scripts/release/" + name }

    func run(_ name: String, _ body: () async -> Outcome) async {
        startLog("lf release: \(name), \(Date())")
        var outcome = await body()
        if case .notSignedIn = outcome { outcome = await signInFlow() }
        switch outcome {
        case .done(let summary), .nothingToDo(let summary), .failed(let summary): await prompter.report(summary)
        case .cancelled: break
        case .notSignedIn: await prompter.report("npm on this Mac isn't signed in")
        }
    }

    func trust() async -> Outcome {
        var code: String?
        var rejected = false
        while true {
            setStatus("Trusting packages…")
            let result = await runProcess("/bin/bash", [script("trust-npm-packages.sh")], extraEnvironment: code.map { ["npm_config_otp": $0] } ?? [:])
            if result.status == 0 { return trustSummary(result.output) }
            let wantsCode = mentions(result.output, "EOTP")
            guard wantsCode || mentions(result.output, "E401|ENEEDAUTH") else {
                return .failed("Trust failed: \(lastLine(result.output))")
            }
            // Either complaint can hide the other, so ask npm who it thinks we are.
            guard await signedIn() else { return .notSignedIn }
            guard wantsCode else { return .failed("Trust failed: \(lastLine(result.output))") }
            rejected = code != nil
            guard let next = await prompter.askCode(rejected: rejected) else { return .cancelled }
            code = next
        }
    }

    private func trustSummary(_ output: String) -> Outcome {
        if output.contains("nothing to trust") { return .nothingToDo("Nothing to trust: every version is already on npm.") }
        let lines = output.split(separator: "\n")
        let trusted = lines.filter { $0.hasPrefix("trusting:") }.count
        let skipped = lines.filter { $0.hasPrefix("skipped (already trusted)") }.count
        return .done("Trusted \(trusted) package\(trusted == 1 ? "" : "s"); \(skipped) already trusted.")
    }

    func approve() async -> Outcome {
        setStatus("Listing staged packages…")
        let listed = await runProcess(node, [script("approve-npm-stages.mjs"), "--list"])
        if listed.status == 4 { return .notSignedIn }
        guard listed.status == 0 else { return .failed("Could not list staged packages: \(lastLine(listed.output))") }
        if listed.output.contains("nothing staged") { return .nothingToDo("Nothing is staged for this release.") }
        let matching = listed.output.split(separator: "\n").filter { !$0.hasPrefix("left out:") }.map(String.init)
        guard await prompter.confirmApproval(list: matching.joined(separator: "\n")) else { return .cancelled }

        var rejected = false
        while true {
            guard let code = await prompter.askCode(rejected: rejected) else { return .cancelled }
            setStatus("Approving staged packages…")
            let result = await runProcess(node, [script("approve-npm-stages.mjs")], extraEnvironment: ["npm_config_otp": code])
            switch result.status {
            case 0: return .done(lastLine(result.output))
            case 3: rejected = true
            case 4: return .notSignedIn
            default: return .failed("Approval failed: \(lastLine(result.output))")
            }
        }
    }

    private func signedIn() async -> Bool {
        await runProcess(npx, npmArguments(["whoami"])).status == 0
    }

    private func signInFlow() async -> Outcome {
        guard await prompter.offerSignIn() else { return .cancelled }
        setStatus("Finish the npm sign-in in your browser…")
        // Without a terminal npm prints the sign-in URL and polls for the result instead of opening the browser itself.
        let opened = OpenOnce()
        let prompter = self.prompter
        let result = await runProcess(npx, npmArguments(["login"])) { line in
            guard opened.claim(), let range = line.range(of: "https://\\S+", options: .regularExpression), let url = URL(string: String(line[range])) else { return }
            Task { @MainActor in prompter.signInURL(url) }
        }
        return result.status == 0
            ? .done("Signed in to npm. Run the action again.")
            : .failed("npm sign-in failed: \(lastLine(result.output))")
    }
}

/// True for the first caller that finds a URL, so a line mentioning two links opens one.
final class OpenOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if opened { return false }
        opened = true
        return true
    }
}

// MARK: the menu bar app and its window

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let trustItem = NSMenuItem(title: "Trust packages for the next release", action: #selector(trustClicked), keyEquivalent: "")
    private let approveItem = NSMenuItem(title: "Approve staged packages…", action: #selector(approveClicked), keyEquivalent: "")
    private let trustButton = NSButton(title: "Trust packages for the next release", target: nil, action: #selector(trustClicked))
    private let approveButton = NSButton(title: "Approve staged packages…", target: nil, action: #selector(approveClicked))
    private let statusLabel = NSTextField(labelWithString: "Ready")
    private var window: NSWindow?
    private var busy = false
    private lazy var actions = Actions(prompter: AlertPrompter { [weak self] in
        guard let window = self?.window, window.isVisible else { return nil }
        return window
    }) { [weak self] status in self?.show(status: status) }
    private var runningItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem.button?.image = NSImage(systemSymbolName: "shippingbox", accessibilityDescription: "lf release")

        let menu = NSMenu()
        menu.autoenablesItems = false
        let logItem = NSMenuItem(title: "Show last log", action: #selector(showLog), keyEquivalent: "")
        let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        for item in [trustItem, approveItem, .separator(), logItem, quitItem] { menu.addItem(item) }
        for item in [trustItem, approveItem, logItem] { item.target = self }
        statusItem.menu = menu

        installMainMenu()
        showWindow()
    }

    /// Spotlight opening a running app arrives here.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return false
    }

    /// An accessory app has no menu bar of its own; this carries the Cmd-W and Cmd-Q shortcuts.
    private func installMainMenu() {
        let main = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Quit lf release", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        for submenu in [appMenu, fileMenu] {
            let item = NSMenuItem()
            item.submenu = submenu
            main.addItem(item)
        }
        NSApp.mainMenu = main
    }

    private func showWindow() {
        let window = self.window ?? makeWindow()
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeWindow() -> NSWindow {
        for button in [trustButton, approveButton] {
            button.target = self
            button.bezelStyle = .rounded
            button.controlSize = .large
            button.translatesAutoresizingMaskIntoConstraints = false
            button.heightAnchor.constraint(equalToConstant: 40).isActive = true
        }
        let title = NSTextField(labelWithString: "lf release")
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        statusLabel.textColor = .secondaryLabelColor
        let logButton = NSButton(title: "Show last log", target: self, action: #selector(showLog))
        logButton.bezelStyle = .inline

        let stack = NSStackView(views: [title, trustButton, approveButton, statusLabel, logButton])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        for button in [trustButton, approveButton] {
            button.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 240),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "lf release"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let content = NSView(frame: window.contentRect(forFrameRect: window.frame))
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        window.contentView = content
        window.setContentSize(NSSize(width: 360, height: stack.fittingSize.height))
        window.center()
        return window
    }

    private func show(status: String) {
        runningItem?.title = status
        statusLabel.stringValue = status
    }

    @objc private func trustClicked() { start(trustItem, "Trust") { await $0.trust() } }
    @objc private func approveClicked() { start(approveItem, "Approve") { await $0.approve() } }

    private func start(_ item: NSMenuItem, _ name: String, _ body: @escaping (Actions) async -> Outcome) {
        guard !busy else { return }
        busy = true
        let idleTitle = item.title
        runningItem = item
        show(status: "\(name)…")
        for each in [trustItem, approveItem] { each.isEnabled = false }
        for each in [trustButton, approveButton] { each.isEnabled = false }
        Task {
            await actions.run(name) { await body(actions) }
            item.title = idleTitle
            runningItem = nil
            statusLabel.stringValue = "Ready"
            busy = false
            for each in [trustItem, approveItem] { each.isEnabled = true }
            for each in [trustButton, approveButton] { each.isEnabled = true }
        }
    }

    @objc private func showLog() {
        if !FileManager.default.fileExists(atPath: logURL.path) { startLog("lf release: no action has run yet") }
        NSWorkspace.shared.open(logURL)
    }
}

// MARK: entry point

if let flag = CommandLine.arguments.firstIndex(of: "--run") {
    let name = CommandLine.arguments.dropFirst(flag + 1).first ?? ""
    Task { @MainActor in
        let actions = Actions(prompter: HeadlessPrompter()) { print("status: \($0)") }
        switch name {
        case "trust": await actions.run("trust") { await actions.trust() }
        case "approve": await actions.run("approve") { await actions.approve() }
        default:
            print("usage: lf-release --run trust|approve")
            exit(2)
        }
        exit(0)
    }
    dispatchMain()
} else {
    let application = NSApplication.shared
    let delegate = MainActor.assumeIsolated { AppDelegate() }
    application.delegate = delegate
    application.setActivationPolicy(.accessory)
    application.run()
}
