// Draws the app icon at build time: a macOS style tile with a fire gradient and a white shipping box.
// usage: swift make-icon.swift <output .iconset directory>
import AppKit

func render(pixels: Int) -> Data {
    let side = CGFloat(pixels)
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

    // The standard macOS tile leaves about 10% margin on each side; its corner radius is about 22.4% of the tile.
    let tile = NSRect(x: side * 0.1, y: side * 0.1, width: side * 0.8, height: side * 0.8)
    let path = NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.2237, yRadius: tile.width * 0.2237)
    NSGradient(
        starting: NSColor(srgbRed: 1.0, green: 0.62, blue: 0.11, alpha: 1),
        ending: NSColor(srgbRed: 0.80, green: 0.10, blue: 0.10, alpha: 1))!
        .draw(in: path, angle: -90)

    let configuration = NSImage.SymbolConfiguration(pointSize: 400, weight: .regular)
        .applying(.init(paletteColors: [.white]))
    let symbol = NSImage(systemSymbolName: "shippingbox.fill", accessibilityDescription: nil)!
        .withSymbolConfiguration(configuration)!
    let box = tile.width * 0.5
    let scale = min(box / symbol.size.width, box / symbol.size.height)
    let drawn = NSSize(width: symbol.size.width * scale, height: symbol.size.height * scale)
    symbol.draw(
        in: NSRect(x: tile.midX - drawn.width / 2, y: tile.midY - drawn.height / 2, width: drawn.width, height: drawn.height),
        from: .zero, operation: .sourceOver, fraction: 1)

    return bitmap.representation(using: .png, properties: [:])!
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: make-icon.swift <output .iconset directory>\n".utf8))
    exit(2)
}
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    try render(pixels: size).write(to: directory.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(pixels: size * 2).write(to: directory.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
