// Renders the menu-bar menu offscreen, light and dark, at 2x, without opening it: for checking
// it to the pixel without touching the screen. Not part of the app.
//
//   xcrun swiftc -O -target arm64-apple-macos26.0 Sources/Menu.swift tools/menu-render/main.swift -o /tmp/menu-render
//   /tmp/menu-render <out-dir> [--hover <design-id>]
//
// The custom rows are Menu.swift's own views, built by KilnMenu exactly as the app builds them.
// The native rows are AppKit's own menu item views, taken from the menu's implementation
// (private API, here only; the app never calls it), so their columns are the real ones. What
// this cannot show: the menu's glass and the header's NSGlassEffectView, which the window server
// composites; a flat stand-in is painted behind them instead (light #F6F6F6, dark #2C2C2E, the
// card a shade off), so judge layout, type and colour here, and the glass on the real menu.
import AppKit
import ObjectiveC

typealias MakeView = @convention(c) (AnyObject, Selector, Int, AnyObject?) -> Unmanaged<NSView>?

func designs(_ root: URL) -> [MenuState.DesignEntry] {
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).filter { !$0.hasPrefix("_") && !$0.hasPrefix(".") }
    return names.compactMap { id -> (Double, MenuState.DesignEntry)? in
        let folder = root.appendingPathComponent(id)
        guard let meta = (try? Data(contentsOf: folder.appendingPathComponent("design.json")))
            .flatMap({ (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }) else { return nil }
        let hasPage = FileManager.default.fileExists(atPath: folder.appendingPathComponent("index.html").path)
        return ((meta["order"] as? Double) ?? .infinity, .init(id: id, name: meta["name"] as? String ?? id, hasPage: hasPage))
    }.sorted { $0.0 < $1.0 }.map(\.1)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let args = CommandLine.arguments
    guard args.count >= 2 else {
        print("usage: menu-render <out-dir> [--hover <design-id>] [--light running|covered|paused]")
        exit(64)
    }
    let out = URL(fileURLWithPath: args[1], isDirectory: true)
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    func option(_ flag: String) -> String? { args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
    let light: MenuState.Light = switch option("--light") {
    case "covered": .covered
    case "paused": .paused
    default: .running
    }

    let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/kiln-wall/designs")
    let state = MenuState(
        light: light,
        stateText: light == .running ? "Running" : light == .covered ? "Desktop covered" : "Paused by you",
        feedText: light == .covered ? "Feed: kiln-feed.py (pid 95261), held at 1000 ms" : "Feed: kiln-feed.py (pid 95261)",
        designName: "The Ledger", periodMs: 300, designs: designs(root), currentDesign: "ledger",
        designsFolder: "~/.config/kiln-wall/designs", hidden: false, pausedByYou: light == .paused,
        matchDesktop: true, launchAtLogin: false)
    let kiln = KilnMenu(min: 100, max: 1000, step: 100) { state }
    kiln.menuNeedsUpdate(kiln.menu)
    let menu = kiln.menu

    let impl = menu.perform(NSSelectorFromString("_menuImpl"))!.takeUnretainedValue() as! NSObject
    _ = impl.perform(NSSelectorFromString("loadView"))
    let makeSel = NSSelectorFromString("makeViewForMenuItemAtIndex:withFilterQuery:")
    let make = unsafeBitCast(impl.method(for: makeSel), to: MakeView.self)

    let width = menu.size.width
    print("menu size \(menu.size)")
    var rows: [(NSView, CGFloat)] = []
    for (i, item) in menu.items.enumerated() {
        if let view = item.view {
            rows.append((view, view.frame.height))
        } else if let view = make(impl, makeSel, i, nil)?.takeUnretainedValue() {
            rows.append((view, item.isSeparatorItem ? 11 : 24))
        }
    }
    let height = rows.reduce(10) { $0 + $1.1 }
    print("stacked height \(height) (menu.size says \(menu.size.height))")

    final class Backdrop: NSView {
        var card = NSRect.zero
        override func draw(_ dirtyRect: NSRect) {
            let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            (dark ? NSColor(srgbRed: 0x2C / 255, green: 0x2C / 255, blue: 0x2E / 255, alpha: 1)
                  : NSColor(srgbRed: 0xF6 / 255, green: 0xF6 / 255, blue: 0xF6 / 255, alpha: 1)).setFill()
            bounds.fill()
            (dark ? NSColor(white: 1, alpha: 0.07) : NSColor(white: 1, alpha: 0.75)).setFill()
            NSBezierPath(roundedRect: card, xRadius: 10, yRadius: 10).fill()
        }
    }
    let backdrop = Backdrop(frame: NSRect(x: 0, y: 0, width: width, height: height))
    let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: width, height: height),
                          styleMask: .borderless, backing: .buffered, defer: true)
    window.contentView = backdrop
    var y = height - 5
    for (view, h) in rows {
        y -= h
        // Each row in its own holder: AppKit keeps a menu item's custom view sized to the
        // item, and moving the holder leaves that alone.
        let holder = NSView(frame: NSRect(x: 0, y: y, width: width, height: h))
        backdrop.addSubview(holder)
        holder.addSubview(view)
        view.frame = holder.bounds
        // The glass draws as an opaque white sheet when cached offscreen: its content goes on
        // a plain view in its place, over the painted stand-in.
        if #available(macOS 26.0, *), view is StatusHeaderView,
           let glass = view.subviews.first as? NSGlassEffectView, let content = glass.contentView {
            let plain = NSView(frame: glass.frame)
            glass.contentView = nil
            content.frame = plain.bounds
            plain.addSubview(content)
            view.replaceSubview(glass, with: plain)
            backdrop.card = plain.convert(plain.bounds, to: backdrop)
        }
    }
    backdrop.layoutSubtreeIfNeeded()
    for case let holder in backdrop.subviews { if let view = holder.subviews.first, view.frame != holder.bounds { print("moved: \(type(of: view)) \(view.frame) in \(holder.frame)") } }
    // Clipped text: a label narrower or shorter than its text.
    for case let field as NSTextField in backdrop.allSubviews where !field.stringValue.isEmpty {
        let need = field.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: 10000, height: 10000))
        let clipped = need.width > field.frame.width + 0.5 || need.height > field.frame.height + 0.5
        print("\(clipped ? "CLIPPED" : "fits   ") '\(field.stringValue)' needs \(need.width)x\(need.height) has \(field.frame.size)")
    }
    if let hover = option("--hover") {
        for case let tile as DesignTileView in backdrop.allSubviews where tile.design.id == hover {
            tile.hovering = true
            tile.onHover(true)
        }
    }
    for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
        backdrop.appearance = NSAppearance(named: appearance)
        backdrop.layoutSubtreeIfNeeded()
        backdrop.needsDisplay = true
        for view in backdrop.allSubviews { view.needsDisplay = true }
        let rep = backdrop.bitmapImageRepForCachingDisplay(in: backdrop.bounds)!
        backdrop.cacheDisplay(in: backdrop.bounds, to: rep)
        let file = out.appendingPathComponent("menu-\(name)\(option("--light").map { "-" + $0 } ?? "")\(option("--hover").map { "-hover-" + $0 } ?? "")@2x.png")
        try! rep.representation(using: .png, properties: [:])!.write(to: file)
        print("wrote \(file.path) (\(rep.pixelsWide)x\(rep.pixelsHigh))")
    }
}

extension NSView {
    var allSubviews: [NSView] { subviews + subviews.flatMap(\.allSubviews) }
}
