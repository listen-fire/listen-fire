// A menu bar app for the two npm release steps that need the maintainer's 2FA:
// letting CI upload the packages that are ready, and publishing what CI staged.
// Its window shows what is waiting, from scripts/release/npm-release-status.mjs.
// It runs the repository's release scripts with no terminal. npm cannot prompt
// without one, so the app asks for the authenticator code itself and hands it to
// npm in the environment (npm_config_otp), never on a command line and never in the log.
//
//   lf-release                  the menu bar app
//   lf-release --run <action>   runs one action headless and prints what the alert would say
//                               (actions: status, trust, approve; the code, if any, from LF_RELEASE_HEADLESS_CODE;
//                               LF_RELEASE_HEADLESS_SIGN_IN=1 accepts the sign-in offer)
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
    private let logged: Bool

    init(onLine: (@Sendable (String) -> Void)?, logged: Bool) {
        self.onLine = onLine
        self.logged = logged
    }

    func append(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.lock()
        let chunk = String(decoding: data, as: UTF8.self)
        text += chunk
        if logged { appendToLog(data) }
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
    logged: Bool = true,
    onLine: (@Sendable (String) -> Void)? = nil
) async -> ProcessResult {
    if logged { appendToLog(Data("\n$ \(([executable] + arguments).joined(separator: " "))\n".utf8)) }
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

    let sink = OutputSink(onLine: onLine, logged: logged)
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

// MARK: what is waiting

struct ReadyPackage: Decodable {
    let name: String
    let version: String
    let onNpm: String?
}

struct StagedPackage: Decodable {
    let name: String
    let version: String
    let tag: String
}

struct ReleaseStatus: Decodable {
    let signedIn: Bool
    let ready: [ReadyPackage]
    /// nil when npm is not signed in, so the staged list cannot be read.
    let staged: [StagedPackage]?
}

enum ButtonAction { case uploadReady, publishStaged, signIn }

struct ActionButton {
    let title: String
    let caption: String?
    let action: ButtonAction
}

/// One part of the window's content; the window draws it and `--run status` prints it.
enum Block {
    case section(heading: String, note: String, lines: [String], button: ActionButton)
    case message(String, button: ActionButton?)
}

func blocks(for status: ReleaseStatus) -> [Block] {
    var result: [Block] = []
    if !status.ready.isEmpty {
        result.append(.section(
            heading: "Ready to release", note: "(newer here than on npm)",
            lines: status.ready.map { "\($0.name)   \($0.onNpm ?? "new") → \($0.version)" },
            button: ActionButton(title: "Let CI upload these", caption: "asks for your 2FA", action: .uploadReady)))
    }
    if let staged = status.staged {
        if !staged.isEmpty {
            result.append(.section(
                heading: "Waiting for you to publish", note: "(uploaded by CI)",
                lines: staged.map { "\($0.name)   \($0.version)" + ($0.tag == "latest" ? "" : " (\($0.tag))") },
                button: ActionButton(title: "Publish these", caption: "asks for your authenticator code", action: .publishStaged)))
        }
    } else {
        result.append(.message(
            "npm isn't signed in on this Mac, so staged packages can't be listed",
            button: ActionButton(title: "Sign in", caption: nil, action: .signIn)))
    }
    if result.isEmpty {
        result.append(.message("Nothing to do: npm has every version in this checkout.", button: nil))
    }
    return result
}

func plural(_ count: Int, _ noun: String) -> String { "\(count) \(noun)\(count == 1 ? "" : "s")" }

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
        alert.messageText = "Publish these staged packages?"
        alert.informativeText = list
        alert.addButton(withTitle: "Publish")
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
        print("ALERT confirm publishing:\n\(list)")
        if code == nil { print("(headless: not confirmed without LF_RELEASE_HEADLESS_CODE)") }
        return code != nil
    }

    func askCode(rejected: Bool) async -> String? {
        print("ALERT ask for authenticator code\(rejected ? " (previous refused)" : "")")
        return rejected ? nil : code
    }

    func offerSignIn() async -> Bool {
        print("ALERT npm on this Mac isn't signed in; button: Sign in (runs `npm login`, URL opened in the browser)")
        return ProcessInfo.processInfo.environment["LF_RELEASE_HEADLESS_SIGN_IN"] == "1"
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
    // LF_RELEASE_NPX stands in a fake npx for the headless sign-in test.
    private let npx = ProcessInfo.processInfo.environment["LF_RELEASE_NPX"] ?? nodeBin + "/npx"

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

    /// Asks npm what is waiting. Not logged: the log stays the last action's.
    func checkStatus() async -> Result<ReleaseStatus, StatusError> {
        setStatus("Checking npm…")
        let result = await runProcess(node, [script("npm-release-status.mjs"), "--json"], logged: false)
        guard result.status == 0, let data = result.output.data(using: .utf8),
              let status = try? JSONDecoder().decode(ReleaseStatus.self, from: data) else {
            return .failure(StatusError(message: "Could not check npm: \(lastLine(result.output))"))
        }
        return .success(status)
    }

    func trust(packages: [String]) async -> Outcome {
        guard !packages.isEmpty else { return .nothingToDo("Nothing to upload: npm has every version in this checkout.") }
        var code: String?
        var rejected = false
        while true {
            setStatus("Letting CI upload \(plural(packages.count, "package"))…")
            let result = await runProcess("/bin/bash", [script("trust-npm-packages.sh")] + packages, extraEnvironment: code.map { ["npm_config_otp": $0] } ?? [:])
            if result.status == 0 { return trustSummary(result.output) }
            let wantsCode = mentions(result.output, "EOTP")
            guard wantsCode || mentions(result.output, "E401|ENEEDAUTH") else {
                return .failed("Letting CI upload failed: \(lastLine(result.output))")
            }
            // Either complaint can hide the other, so ask npm who it thinks we are.
            guard await signedIn() else { return .notSignedIn }
            guard wantsCode else { return .failed("Letting CI upload failed: \(lastLine(result.output))") }
            rejected = code != nil
            guard let next = await prompter.askCode(rejected: rejected) else { return .cancelled }
            code = next
        }
    }

    private func trustSummary(_ output: String) -> Outcome {
        let lines = output.split(separator: "\n")
        let allowed = lines.filter { $0.hasPrefix("trusting:") }.count
        let skipped = lines.filter { $0.hasPrefix("skipped (already trusted)") }.count
        return .done("CI may now upload \(plural(allowed, "package")); \(skipped) already allowed. The next push to main uploads them.")
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
            setStatus("Publishing \(plural(matching.count, "package"))…")
            let result = await runProcess(node, [script("approve-npm-stages.mjs")], extraEnvironment: ["npm_config_otp": code])
            switch result.status {
            case 0: return .done(lastLine(result.output))
            case 3: rejected = true
            case 4: return .notSignedIn
            default: return .failed("Publishing failed: \(lastLine(result.output))")
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
        let picker = SignInURLPicker()
        let prompter = self.prompter
        let result = await runProcess(npx, npmArguments(["login"])) { line in
            guard let url = picker.pick(line) else { return }
            Task { @MainActor in prompter.signInURL(url) }
        }
        return result.status == 0
            ? .done("Signed in to npm. Run the action again.")
            : .failed("npm sign-in failed: \(lastLine(result.output))")
    }
}

struct StatusError: Error { let message: String }

/// The sign-in URL is the line after npm's title ("Login at:", or "Authenticate your account at:" for a
/// 2FA challenge). Other lines carry URLs too (npm's notices name the registry and docs), so a URL
/// counts only right after a title, and only the first one opens.
final class SignInURLPicker: @unchecked Sendable {
    private let lock = NSLock()
    private var afterTitle = false
    private var opened = false
    func pick(_ line: String) -> URL? {
        lock.lock()
        defer { lock.unlock() }
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        defer { afterTitle = trimmed.hasSuffix(" at:") }
        guard afterTitle, !opened, trimmed.hasPrefix("https://"), let url = URL(string: trimmed) else { return nil }
        opened = true
        return url
    }
}

// MARK: the menu bar app and its window

let windowWidth: CGFloat = 420

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private enum Content {
        case checking
        case known(ReleaseStatus)
        case unknown(String)
    }

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let uploadItem = NSMenuItem(title: "Let CI upload ready packages", action: #selector(uploadClicked), keyEquivalent: "")
    private let publishItem = NSMenuItem(title: "Publish staged packages…", action: #selector(publishClicked), keyEquivalent: "")
    private let statusLabel = NSTextField(labelWithString: "")
    private let stack = NSStackView()
    private let refreshButton = NSButton(title: "Refresh", target: nil, action: #selector(refreshClicked))
    private let logButton = NSButton(title: "Show last log", target: nil, action: #selector(showLog))
    private var actionButtons: [NSButton] = []
    private var window: NSWindow?
    private var content = Content.checking
    private var busy = false
    private lazy var actions = Actions(prompter: AlertPrompter { [weak self] in
        guard let window = self?.window, window.isVisible else { return nil }
        return window
    }) { [weak self] status in self?.show(status: status) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem.button?.image = NSImage(systemSymbolName: "shippingbox", accessibilityDescription: "lf release")

        let menu = NSMenu()
        menu.autoenablesItems = false
        let openItem = NSMenuItem(title: "Open lf release", action: #selector(openClicked), keyEquivalent: "")
        let logItem = NSMenuItem(title: "Show last log", action: #selector(showLog), keyEquivalent: "")
        let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        for item in [uploadItem, publishItem, .separator(), openItem, logItem, quitItem] { menu.addItem(item) }
        for item in [uploadItem, publishItem, openItem, logItem] { item.target = self }
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
        refresh()
    }

    private func makeWindow() -> NSWindow {
        for button in [refreshButton, logButton] {
            button.target = self
            button.bezelStyle = .inline
        }
        statusLabel.textColor = .secondaryLabelColor
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 16, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: windowWidth, height: 200),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "lf release"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let container = NSView(frame: window.contentRect(forFrameRect: window.frame))
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.widthAnchor.constraint(equalToConstant: windowWidth),
        ])
        window.contentView = container
        window.center()
        self.window = window
        render()
        return window
    }

    // MARK: drawing

    private func wrapped(_ label: NSTextField) -> NSTextField {
        label.maximumNumberOfLines = 0
        label.lineBreakMode = .byWordWrapping
        label.preferredMaxLayoutWidth = windowWidth - 40
        return label
    }

    private func actionButton(_ spec: ActionButton) -> NSView {
        let button = NSButton(title: spec.title, target: self, action: #selector(blockButtonClicked(_:)))
        button.bezelStyle = .rounded
        button.controlSize = .large
        button.isEnabled = !busy
        button.identifier = NSUserInterfaceItemIdentifier("\(spec.action)")
        actionButtons.append(button)
        guard let caption = spec.caption else { return button }
        let note = NSTextField(labelWithString: caption)
        note.textColor = .secondaryLabelColor
        let row = NSStackView(views: [button, note])
        row.spacing = 10
        return row
    }

    private func view(for block: Block) -> NSView {
        switch block {
        case .message(let text, let button):
            let views: [NSView] = [wrapped(NSTextField(labelWithString: text))] + (button.map { [actionButton($0)] } ?? [])
            return column(views)
        case .section(let heading, let note, let lines, let button):
            let title = NSTextField(labelWithString: heading)
            title.font = .systemFont(ofSize: 15, weight: .semibold)
            let hint = NSTextField(labelWithString: note)
            hint.textColor = .secondaryLabelColor
            let header = NSStackView(views: [title, hint])
            header.alignment = .firstBaseline
            header.spacing = 8
            let rows = lines.map { line -> NSView in
                let label = wrapped(NSTextField(labelWithString: line))
                label.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
                return label
            }
            return column([header] + rows + [actionButton(button)])
        }
    }

    private func column(_ views: [NSView]) -> NSStackView {
        let column = NSStackView(views: views)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 6
        return column
    }

    /// Redraws everything from the current content and `busy`, then fits the window to it.
    private func render() {
        guard window != nil else { return }
        actionButtons = []
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        let title = NSTextField(labelWithString: "lf release")
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        stack.addArrangedSubview(title)
        switch content {
        case .checking: break
        case .known(let status): for block in blocks(for: status) { stack.addArrangedSubview(view(for: block)) }
        case .unknown(let message): stack.addArrangedSubview(wrapped(NSTextField(labelWithString: message)))
        }
        if !statusLabel.stringValue.isEmpty { stack.addArrangedSubview(statusLabel) }
        let footer = NSStackView(views: [refreshButton, NSTextField(labelWithString: "·"), logButton])
        footer.spacing = 6
        stack.addArrangedSubview(footer)

        refreshButton.isEnabled = !busy
        for item in [uploadItem, publishItem] { item.isEnabled = !busy }
        fitWindow()
    }

    private func fitWindow() {
        guard let window else { return }
        stack.layoutSubtreeIfNeeded()
        let top = window.frame.maxY
        window.setContentSize(NSSize(width: windowWidth, height: stack.fittingSize.height))
        window.setFrameOrigin(NSPoint(x: window.frame.origin.x, y: top - window.frame.height))
    }

    private func show(status: String) {
        statusLabel.stringValue = status
        render()
    }

    // MARK: doing things

    /// One thing at a time: the buttons are disabled meanwhile, and the window checks npm again afterwards.
    private func exclusive(_ work: @escaping @MainActor () async -> Void) {
        guard !busy else { return }
        busy = true
        render()
        Task {
            await work()
            await check()
            busy = false
            show(status: "")
        }
    }

    private func check() async {
        content = .checking
        render()
        switch await actions.checkStatus() {
        case .success(let status): content = .known(status)
        case .failure(let error): content = .unknown(error.message)
        }
    }

    private func refresh() {
        exclusive {}
    }

    private var readyNames: [String] {
        if case .known(let status) = content { return status.ready.map(\.name) }
        return []
    }

    @objc private func refreshClicked() { refresh() }
    @objc private func openClicked() { showWindow() }

    @objc private func uploadClicked() {
        exclusive { [self] in await actions.run("upload") { await actions.trust(packages: readyNames) } }
    }

    @objc private func publishClicked() {
        exclusive { [self] in await actions.run("publish") { await actions.approve() } }
    }

    @objc private func blockButtonClicked(_ sender: NSButton) {
        switch sender.identifier?.rawValue {
        case "\(ButtonAction.uploadReady)": uploadClicked()
        case "\(ButtonAction.publishStaged)": publishClicked()
        case "\(ButtonAction.signIn)": exclusive { [self] in await actions.run("sign in") { .notSignedIn } }
        default: break
        }
    }

    @objc private func showLog() {
        if !FileManager.default.fileExists(atPath: logURL.path) { startLog("lf release: no action has run yet") }
        NSWorkspace.shared.open(logURL)
    }
}

// MARK: entry point

/// What the window shows for a status, in words, for `--run status`.
func printWindowContent(_ result: Result<ReleaseStatus, StatusError>) {
    print("lf release\n")
    switch result {
    case .failure(let error): print(error.message)
    case .success(let status):
        for block in blocks(for: status) {
            switch block {
            case .message(let text, let button):
                print(text)
                if let button { print("[ \(button.title) ]") }
            case .section(let heading, let note, let lines, let button):
                print("\(heading)  \(note)")
                for line in lines { print("  \(line)") }
                print("[ \(button.title) ]  \(button.caption ?? "")")
            }
            print("")
        }
    }
    print("Refresh · Show last log")
}

if let flag = CommandLine.arguments.firstIndex(of: "--run") {
    let name = CommandLine.arguments.dropFirst(flag + 1).first ?? ""
    Task { @MainActor in
        let actions = Actions(prompter: HeadlessPrompter()) { print("status: \($0)") }
        switch name {
        case "status": printWindowContent(await actions.checkStatus())
        case "trust":
            switch await actions.checkStatus() {
            case .success(let status): await actions.run("upload") { await actions.trust(packages: status.ready.map(\.name)) }
            case .failure(let error): print(error.message)
            }
        case "approve": await actions.run("publish") { await actions.approve() }
        default:
            print("usage: lf-release --run status|trust|approve")
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
