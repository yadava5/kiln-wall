// The menu-bar menu, laid out like Control Center: a grid of rounded tiles, each one kind of
// control, with as little text as the controls can stand. main.swift owns the state and the
// actions; this builds the menu, keeps it current while it is open, and draws every tile itself.
// The only native item is the footer's, which carries Quit's ⌘Q.
//
// The grid: 308 pt wide, tiles 10 pt from the menu's edge (its own 5 pt padding plus 5), 8 pt
// gutters, two columns of 140 or four of 66. Every tile has the same 14 pt corner; what sits
// 8 pt inside a tile has a 6 pt one, so the corners stay concentric. Tiles are flat fills over
// the menu's own material (Liquid Glass on macOS 26), the way Control Center's modules sit on
// its panel; tools/menu-render paints the material's stand-in and renders the rest as is.
import AppKit
import ImageIO
import UniformTypeIdentifiers

enum MenuMetrics {
    static let width: CGFloat = 308
    static let edge: CGFloat = 10
    static let gap: CGFloat = 8
    static let content = width - 2 * edge  // 288
    static let half = (content - gap) / 2  // 140
    static let quarter = (content - 3 * gap) / 4  // 66
    static let tileRadius: CGFloat = 14
    static let innerRadius: CGFloat = 6
    static let inset: CGFloat = 8  // a tile's padding
    static let symbol = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium, scale: .small)
    static let titleFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
    static let labelFont = NSFont.systemFont(ofSize: 11, weight: .medium)
    static let smallFont = NSFont.systemFont(ofSize: 11)
    static let valueFont = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)

    // Measured with palmath (2026-11-05) over the tiles as menu-render paints them, light
    // #EAEAEA (black 0.05 on #F6F6F6) and dark #414143 (white 0.10 on #2C2C2E): the dim text is
    // 5.0:1 / APCA Lc 70 in light and 6.3:1 / Lc 62 in dark, a step under the titles' 13:1.
    static let dimText = dynamic(dark: NSColor(white: 1, alpha: 0.70), light: NSColor(white: 0, alpha: 0.60))
    static let tileFill = dynamic(dark: NSColor(white: 1, alpha: 0.10), light: NSColor(white: 0, alpha: 0.05))
    static let tileHover = dynamic(dark: NSColor(white: 1, alpha: 0.15), light: NSColor(white: 0, alpha: 0.085))
    static let tilePressed = dynamic(dark: NSColor(white: 1, alpha: 0.20), light: NSColor(white: 0, alpha: 0.13))
    // The chosen segment's pill and the slider's empty track, a step lighter than the tile.
    static let pill = dynamic(dark: NSColor(white: 1, alpha: 0.18), light: NSColor(white: 1, alpha: 1))
    static let track = dynamic(dark: NSColor(white: 1, alpha: 0.12), light: NSColor(white: 0, alpha: 0.10))
    // A hairline that keeps a light shape's edge on a light menu.
    static let hairline = dynamic(dark: NSColor(white: 1, alpha: 0.08), light: NSColor(white: 0, alpha: 0.08))

    private static func dynamic(dark: NSColor, light: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        }
    }

    // Black or white, whichever reads better on `fill` in the current drawing appearance, by
    // WCAG 2 contrast: white loses on the green, yellow and orange accents (2:1 on green).
    static func ink(on fill: NSColor) -> NSColor {
        guard let c = fill.usingColorSpace(.sRGB) else { return .white }
        func linear(_ v: CGFloat) -> CGFloat { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        let l = 0.2126 * linear(c.redComponent) + 0.7152 * linear(c.greenComponent) + 0.0722 * linear(c.blueComponent)
        return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? .white : .black
    }
}

// Everything the menu shows, read from the app each time it opens and on every change while open.
struct MenuState {
    enum Light { case running, covered, paused }

    struct DesignEntry {
        let id: String
        let name: String
        let hasPage: Bool
    }

    var light: Light
    var stateText: String  // "Running", "Paused by you", "Desktop covered, Low Power Mode"
    var feedText: String
    var designName: String  // what is shown: the design, or the fallback page
    var periodMs: Int
    var designs: [DesignEntry]
    var currentDesign: String?
    var designsFolder: String
    var hidden: Bool
    var pausedByYou: Bool
    var matchDesktop: Bool
    var launchAtLogin: Bool
    var appearance: Appearance
    var tempUnit: TempUnit
}

@MainActor
final class KilnMenu: NSObject, NSMenuDelegate {
    let menu = NSMenu()
    private(set) var isOpen = false

    // Wired by main.swift.
    var state: () -> MenuState
    var setPeriod: (Int) -> Void = { _ in }
    var stepPeriod: (Int) -> Void = { _ in }
    var chooseDesign: (String) -> Void = { _ in }
    var setAppearance: (Appearance) -> Void = { _ in }
    var setTempUnit: (TempUnit) -> Void = { _ in }
    var setMatchDesktop: (Bool) -> Void = { _ in }
    // Returns the state it ended in (a failed change keeps the old one).
    var setLaunchAtLogin: (Bool) -> Bool = { $0 }
    var togglePause: () -> Void = {}
    var toggleShown: () -> Void = {}
    var reloadPage: () -> Void = {}
    var openPageFolder: () -> Void = {}
    // Before each opening, e.g. to refresh the shown design's picture.
    var willOpen: () -> Void = {}

    private let status = StatusTileView()
    private let appearanceTile = SegmentTileView(label: "Appearance", items: [
        .init(symbol: "circle.lefthalf.filled", label: "Auto", tip: "Auto: the day look by day, the night look after sunset"),
        .init(symbol: "sun.max.fill", label: "Light", tip: "Light: the day look, always"),
        .init(symbol: "moon.fill", label: "Dark", tip: "Dark: the night look, always"),
    ])
    private let unitTile = SegmentTileView(label: "Temperature unit", items: [
        .init(text: "°F", label: "Fahrenheit", tip: "Fahrenheit"),
        .init(text: "°C", label: "Celsius", tip: "Celsius"),
    ])
    private let period: PeriodControlView
    private let grid = DesignGridView()
    private let pauseTile = ToggleTileView(symbol: "pause.fill", title: "Pause", label: "Pause the wallpaper")
    private let hideTile = ToggleTileView(symbol: "eye.slash.fill", title: "Hide", label: "Hide the wallpaper")
    private let matchTile = ToggleTileView(symbol: "photo.fill.on.rectangle.fill", title: "Match", label: "Match the macOS wallpaper to the design",
                                           tip: "Keep the macOS desktop picture matched to the live wallpaper")
    private let loginTile = ToggleTileView(symbol: "power", title: "Login", label: "Launch at login", tip: "Launch KilnWall at login")
    private let gridItem = NSMenuItem()
    private var lastBeat = Date.distantPast

    init(min: Int, max: Int, step: Int, state: @escaping () -> MenuState) {
        self.state = state
        period = PeriodControlView(min: min, max: max, step: step)
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false

        // Row 1: status beside appearance over unit. The menu pads 5 pt above the first row.
        let top = RowView(height: 64, above: 5)
        status.setFrameOrigin(NSPoint(x: MenuMetrics.edge, y: 0))
        appearanceTile.setFrameOrigin(NSPoint(x: MenuMetrics.edge + MenuMetrics.half + MenuMetrics.gap, y: 36))
        unitTile.setFrameOrigin(NSPoint(x: MenuMetrics.edge + MenuMetrics.half + MenuMetrics.gap, y: 0))
        top.place(status, appearanceTile, unitTile)
        add(top)
        period.setFrameOrigin(NSPoint(x: MenuMetrics.edge, y: 0))
        add(RowView(height: period.frame.height, above: MenuMetrics.gap).placing(period))
        gridItem.view = grid
        menu.addItem(gridItem)
        let toggles = RowView(height: MenuMetrics.quarter, above: MenuMetrics.gap)
        for (i, tile) in [pauseTile, hideTile, matchTile, loginTile].enumerated() {
            tile.setFrameOrigin(NSPoint(x: MenuMetrics.edge + CGFloat(i) * (MenuMetrics.quarter + MenuMetrics.gap), y: 0))
            toggles.place(tile)
        }
        add(toggles)
        // The footer's item carries ⌘Q: a key equivalent fires through a custom view. terminate:
        // itself, as the native Quit item had.
        let footer = FooterView()
        let quit = NSMenuItem(title: "Quit KilnWall", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        footer.setFrameOrigin(NSPoint(x: MenuMetrics.edge, y: 0))
        quit.view = RowView(height: 24, above: MenuMetrics.gap, below: 5).placing(footer)
        menu.addItem(quit)

        period.onChange = { [weak self] in self?.setPeriod($0) }
        period.onStep = { [weak self] in self?.stepPeriod($0) }
        grid.onChoose = { [weak self] in self?.chooseDesign($0) }
        grid.onPreview = { [weak self] in self?.status.preview = $0 }
        appearanceTile.onChange = { [weak self] in self?.setAppearance(Appearance.allCases[$0]) }
        unitTile.onChange = { [weak self] in self?.setTempUnit(TempUnit.allCases[$0]) }
        pauseTile.onToggle = { [weak self] _ in self?.togglePause() }
        hideTile.onToggle = { [weak self] _ in self?.toggleShown() }
        matchTile.onToggle = { [weak self] in self?.setMatchDesktop($0) }
        loginTile.onToggle = { [weak self] on in
            guard let self else { return }
            self.loginTile.isOn = self.setLaunchAtLogin(on)
        }
        footer.reload.onPress = { [weak self] in self?.reloadPage() }
        footer.folder.onPress = { [weak self] in self?.openPageFolder() }
        footer.quit.onPress = { NSApp.terminate(nil) }
    }

    private func add(_ view: NSView) {
        let item = NSMenuItem()
        item.view = view
        menu.addItem(item)
    }

    // MARK: Keeping it current

    func menuNeedsUpdate(_ menu: NSMenu) {
        willOpen()
        // Designs come and go on disk: the grid is rebuilt each time the menu opens.
        let now = state()
        grid.rebuild(now.designs, current: now.currentDesign, folder: now.designsFolder)
        refresh(now)
    }

    func menuWillOpen(_ menu: NSMenu) { isOpen = true }

    func menuDidClose(_ menu: NSMenu) {
        isOpen = false
        grid.clearHover()
    }

    // While open: a change from the menu itself, a hotkey, the CLI or the system shows at once.
    func refresh() {
        guard isOpen else { return }
        refresh(state())
    }

    private func refresh(_ now: MenuState) {
        status.update(now)
        period.update(periodMs: now.periodMs)
        grid.update(current: now.currentDesign)
        appearanceTile.select(Appearance.allCases.firstIndex(of: now.appearance) ?? 0)
        // One-look designs ignore the appearance (designs/README.md, Preferences): the control
        // dims and says why, and stays where VoiceOver can read it.
        let twoLooks = now.currentDesign.map { Designs.hasTwoLooks($0) } ?? false
        appearanceTile.setEnabled(twoLooks, reason: twoLooks ? nil : "\(now.designName) has one look")
        unitTile.select(TempUnit.allCases.firstIndex(of: now.tempUnit) ?? 0)
        pauseTile.isOn = now.pausedByYou
        hideTile.isOn = now.hidden
        matchTile.isOn = now.matchDesktop
        loginTile.isOn = now.launchAtLogin
    }

    // A line reached the page: the status light pulses, at most every 0.6 s so a 100 ms feed
    // does not flicker.
    func beat() {
        guard isOpen, Date().timeIntervalSince(lastBeat) >= 0.6 else { return }
        lastBeat = Date()
        status.beat()
    }
}

// MARK: - Rows and tiles

// One menu item's view: the tiles of a row, with the gutter above them (and, for the last row,
// the margin below) inside the item, since a menu item view has no margins of its own.
@MainActor
final class RowView: NSView {
    private let below: CGFloat

    init(height: CGFloat, above: CGFloat, below: CGFloat = 0) {
        self.below = below
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: height + above + below))
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    // Each tile at its own x; y is the tile's, lifted over the margin below.
    func place(_ views: NSView...) {
        for view in views {
            view.setFrameOrigin(NSPoint(x: view.frame.minX, y: view.frame.minY + below))
            addSubview(view)
        }
    }

    func placing(_ views: NSView...) -> RowView {
        for view in views { place(view) }
        return self
    }
}

// A rounded tile. Interactive ones brighten under the pointer and darken while pressed; menus
// never make the app active, so the tracking area must be active always.
@MainActor
class TileView: NSView {
    var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }
    var pressed = false { didSet { if pressed != oldValue { needsDisplay = true } } }
    var isInteractive: Bool { true }

    var fillColour: NSColor {
        !isInteractive ? MenuMetrics.tileFill : pressed ? MenuMetrics.tilePressed : hovering ? MenuMetrics.tileHover : MenuMetrics.tileFill
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    var shape: NSBezierPath { NSBezierPath(roundedRect: bounds, xRadius: MenuMetrics.tileRadius, yRadius: MenuMetrics.tileRadius) }

    override func draw(_ dirtyRect: NSRect) {
        fillColour.setFill()
        shape.fill()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        guard isInteractive else { return }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        pressed = false
    }
}

// MARK: - Status

// The one place for live state: the light, the state in a word or two, and what is showing.
// While a design in the grid is under the pointer, its name shows here instead, the way the
// grid's own caption did. The feed's diagnostics are the tooltip and the VoiceOver text.
@MainActor
final class StatusTileView: TileView {
    private let light = StatusLight()
    private let stateLine = label(NSFont.systemFont(ofSize: 12, weight: .semibold), .labelColor)
    private let detail = label(MenuMetrics.smallFont, MenuMetrics.dimText)
    private var shown = ""

    var preview: String? { didSet { updateDetail() } }

    override var isInteractive: Bool { false }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.half, height: 64))
        let inset = MenuMetrics.inset
        // Two lines centred in the tile, the light centred on the first. 12 pt so "Desktop
        // covered" fits beside the light; the longer states truncate and read whole in the tooltip.
        light.frame = NSRect(x: inset, y: 32, width: 20, height: 20)
        stateLine.frame = NSRect(x: inset + 20, y: 33, width: bounds.width - inset - 20 - inset + 4, height: 17)
        stateLine.lineBreakMode = .byTruncatingTail
        detail.frame = NSRect(x: inset + 20, y: 15, width: stateLine.frame.width, height: 15)
        detail.lineBreakMode = .byTruncatingMiddle
        for view in [light, stateLine, detail] as [NSView] { addSubview(view) }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func update(_ state: MenuState) {
        stateLine.stringValue = state.stateText
        shown = state.designName
        light.state = state.light
        toolTip = "\(state.stateText). \(state.feedText)"
        setAccessibilityLabel("\(state.stateText). Showing \(state.designName). \(state.feedText)")
        updateDetail()
    }

    func beat() { light.beat() }

    private func updateDetail() {
        detail.stringValue = preview ?? shown
        detail.textColor = preview == nil ? MenuMetrics.dimText : .labelColor
    }
}

// Green running, grey under a cover (the feed held), orange paused for any other reason. The
// state line beside it says which in words; the colour is never the only signal.
@MainActor
final class StatusLight: NSView {
    private static let diameter: CGFloat = 10
    private let halo = CALayer()

    var state: MenuState.Light = .paused {
        didSet { if state != oldValue { needsDisplay = true } }
    }

    private var colour: NSColor {
        switch state {
        case .running: .systemGreen
        case .covered: .systemGray
        case .paused: .systemOrange
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        halo.opacity = 0
        layer?.addSublayer(halo)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    private var dot: NSRect {
        let d = Self.diameter
        return NSRect(x: (bounds.width - d) / 2, y: (bounds.height - d) / 2, width: d, height: d)
    }

    override func draw(_ dirtyRect: NSRect) {
        colour.setFill()
        NSBezierPath(ovalIn: dot).fill()
    }

    // One ring that grows out of the light and fades: a feed line reached the page. Nothing
    // when Reduce Motion is on; the light itself never moves.
    func beat() {
        guard state == .running, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        var cg: CGColor?
        effectiveAppearance.performAsCurrentDrawingAppearance { cg = self.colour.cgColor }
        halo.frame = dot
        halo.cornerRadius = Self.diameter / 2
        halo.backgroundColor = cg
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 1
        grow.toValue = 2.5
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.45
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]
        group.duration = 0.9
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        halo.add(group, forKey: "beat")
    }
}

// MARK: - Segments

// A capsule of equal segments, one chosen, the way iOS sets Light/Dark: the chosen one on a
// pill, the rest dim until the pointer reaches them. Items are symbols or short text, never
// both. Disabled, the tile fades and its tooltip says why; VoiceOver still reads it.
@MainActor
final class SegmentTileView: TileView {
    struct Item {
        var symbol: String? = nil
        var text: String? = nil
        let label: String
        let tip: String
    }

    var onChange: (Int) -> Void = { _ in }
    private(set) var selected = 0
    private var enabled = true
    private let segments: [SegmentView]
    private static let pillInset: CGFloat = 3

    override var isInteractive: Bool { false }

    init(label: String, items: [Item]) {
        segments = items.map(SegmentView.init)
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.half, height: 28))
        let inner = bounds.insetBy(dx: Self.pillInset, dy: Self.pillInset)
        let width = inner.width / CGFloat(segments.count)
        for (i, segment) in segments.enumerated() {
            segment.frame = NSRect(x: inner.minX + CGFloat(i) * width, y: inner.minY, width: width, height: inner.height)
            segment.onChoose = { [weak self] in self?.choose(i) }
            addSubview(segment)
        }
        setAccessibilityElement(true)
        setAccessibilityRole(.radioGroup)
        setAccessibilityLabel(label)
        select(0)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func select(_ i: Int) {
        guard segments.indices.contains(i) else { return }
        selected = i
        for (j, segment) in segments.enumerated() { segment.isChosen = j == i }
        needsDisplay = true
    }

    func setEnabled(_ on: Bool, reason: String?) {
        enabled = on
        alphaValue = on ? 1 : 0.4
        for segment in segments {
            segment.isEnabled = on
            segment.toolTip = on ? segment.item.tip : reason
            segment.setAccessibilityEnabled(on)
        }
    }

    private func choose(_ i: Int) {
        guard enabled, i != selected else { return }
        select(i)
        onChange(i)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard segments.indices.contains(selected) else { return }
        let pill = segments[selected].frame
        let radius = pill.height / 2
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.12)
        shadow.shadowBlurRadius = 2
        shadow.shadowOffset = NSSize(width: 0, height: -0.5)
        shadow.set()
        MenuMetrics.pill.setFill()
        NSBezierPath(roundedRect: pill, xRadius: radius, yRadius: radius).fill()
        NSGraphicsContext.restoreGraphicsState()
        MenuMetrics.hairline.setStroke()
        let edge = NSBezierPath(roundedRect: pill.insetBy(dx: 0.25, dy: 0.25), xRadius: radius, yRadius: radius)
        edge.lineWidth = 0.5
        edge.stroke()
    }
}

@MainActor
final class SegmentView: NSView {
    let item: SegmentTileView.Item
    var onChoose: () -> Void = {}
    var isChosen = false { didSet { setAccessibilityValue(isChosen); tint() } }
    var isEnabled = true
    private var hovering = false { didSet { tint() } }
    private let icon = NSImageView()
    private let text = label(NSFont.systemFont(ofSize: 11, weight: .semibold), .labelColor)

    init(_ item: SegmentTileView.Item) {
        self.item = item
        super.init(frame: .zero)
        if let symbol = item.symbol {
            icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: item.label)?
                .withSymbolConfiguration(.init(pointSize: 12, weight: .medium, scale: .small))
            icon.imageAlignment = .alignCenter
            addSubview(icon)
        } else {
            text.stringValue = item.text ?? ""
            text.alignment = .center
            addSubview(text)
        }
        toolTip = item.tip
        setAccessibilityElement(true)
        setAccessibilityRole(.radioButton)
        setAccessibilityLabel(item.label)
        setAccessibilityValue(false)
        tint()
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func layout() {
        super.layout()
        icon.frame = bounds
        text.frame = NSRect(x: 0, y: (bounds.height - 15) / 2, width: bounds.width, height: 15)
    }

    private func tint() {
        let colour: NSColor = isChosen || hovering ? .labelColor : MenuMetrics.dimText
        icon.contentTintColor = colour
        text.textColor = colour
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hovering = isEnabled }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) {}

    override func mouseUp(with event: NSEvent) {
        guard isEnabled, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onChoose()
    }

    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        onChoose()
        return true
    }
}

// MARK: - Refresh period

// Left is slower, right is faster, as ⌃⌥- and ⌃⌥= move it (like btop, "+" is faster): the
// tortoise end is 1000 ms, the hare end 100 ms. Ten stops; every stop the slider passes is
// applied at once, through the same path as the hotkeys. The period reads at the right as the
// slider's value; the keys live in the tortoise's and the hare's tooltips.
@MainActor
final class PeriodControlView: TileView {
    var onChange: (Int) -> Void = { _ in }
    var onStep: (Int) -> Void = { _ in }

    private let min: Int, max: Int, step: Int
    private let slider: StopSlider
    private let slower = IconButton(symbol: "tortoise.fill", label: "Slower", tip: "Slower  ⌃⌥−")
    private let faster = IconButton(symbol: "hare.fill", label: "Faster", tip: "Faster  ⌃⌥=")
    private let value = label(MenuMetrics.valueFont, .labelColor)
    private var current = 0

    override var isInteractive: Bool { false }

    init(min: Int, max: Int, step: Int) {
        self.min = min
        self.max = max
        self.step = step
        slider = StopSlider(stops: (max - min) / step + 1)
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.content, height: 48))
        let inset = MenuMetrics.inset, w = bounds.width
        slower.frame = NSRect(x: inset, y: 12, width: 24, height: 24)
        value.frame = NSRect(x: w - inset - 46, y: 16, width: 48, height: 16)
        value.alignment = .right
        faster.frame = NSRect(x: value.frame.minX - 4 - 24, y: 12, width: 24, height: 24)
        slider.frame = NSRect(x: slower.frame.maxX + 6, y: 6, width: faster.frame.minX - 6 - (slower.frame.maxX + 6), height: 36)
        slider.onChange = { [weak self] in self?.slid($0) }
        slider.setAccessibilityLabel("Refresh period")
        slower.onPress = { [weak self] in self?.onStep(step) }
        faster.onPress = { [weak self] in self?.onStep(-step) }
        for view in [slower, slider, faster, value] as [NSView] { addSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    private func ms(at stop: Int) -> Int { max - stop * step }
    private func stop(for ms: Int) -> Int { (max - ms) / step }

    func update(periodMs: Int) {
        current = periodMs
        slider.value = stop(for: periodMs)
        show(periodMs)
        slower.isEnabled = periodMs < max
        faster.isEnabled = periodMs > min
    }

    private func show(_ ms: Int) {
        value.stringValue = "\(ms) ms"
        slider.setAccessibilityValueDescription("\(ms) ms")
    }

    private func slid(_ stop: Int) {
        let ms = ms(at: stop)
        guard ms != current else { return }
        current = ms
        show(ms)
        onChange(ms)
    }
}

// A thick capsule slider with a stop at each tick, like Control Center's display slider with
// the thumb kept: the filled part is the accent, the knob white. Dragging snaps to the nearest
// stop and reports each stop it reaches; VoiceOver steps it by one.
@MainActor
final class StopSlider: NSView {
    var onChange: (Int) -> Void = { _ in }
    let stops: Int
    var value = 0 { didSet { if value != oldValue { needsDisplay = true } } }

    private static let trackHeight: CGFloat = 18
    private static let knob: CGFloat = 14

    init(stops: Int) {
        self.stops = Swift.max(stops, 2)
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.slider)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    private var track: NSRect {
        NSRect(x: 0, y: (bounds.height - Self.trackHeight) / 2, width: bounds.width, height: Self.trackHeight)
    }

    // The knob's centre runs from half a track height in from each end.
    private func x(of stop: Int) -> CGFloat {
        let inset = Self.trackHeight / 2
        return inset + (bounds.width - 2 * inset) * CGFloat(stop) / CGFloat(stops - 1)
    }

    private func stop(at x: CGFloat) -> Int {
        let inset = Self.trackHeight / 2
        let fraction = (x - inset) / (bounds.width - 2 * inset)
        return Swift.min(stops - 1, Swift.max(0, Int((fraction * CGFloat(stops - 1)).rounded())))
    }

    override func draw(_ dirtyRect: NSRect) {
        let track = track, r = Self.trackHeight / 2
        MenuMetrics.track.setFill()
        NSBezierPath(roundedRect: track, xRadius: r, yRadius: r).fill()
        let knobX = x(of: value)
        NSColor.controlAccentColor.setFill()
        NSBezierPath(roundedRect: NSRect(x: track.minX, y: track.minY, width: knobX + r - track.minX, height: track.height),
                     xRadius: r, yRadius: r).fill()
        // A dot at each stop the knob is not on, so the stops read as stops.
        for stop in 0 ..< stops where stop != value {
            let filled = stop < value
            (filled ? MenuMetrics.ink(on: .controlAccentColor).withAlphaComponent(0.45) : MenuMetrics.dimText.withAlphaComponent(0.4)).setFill()
            NSBezierPath(ovalIn: NSRect(x: x(of: stop) - 1, y: track.midY - 1, width: 2, height: 2)).fill()
        }
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.25)
        shadow.shadowBlurRadius = 2
        shadow.shadowOffset = NSSize(width: 0, height: -0.5)
        shadow.set()
        NSColor.white.setFill()
        let k = Self.knob
        NSBezierPath(ovalIn: NSRect(x: knobX - k / 2, y: track.midY - k / 2, width: k, height: k)).fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    private func set(_ stop: Int) {
        guard stop != value else { return }
        value = stop
        onChange(stop)
    }

    // The drag is tracked here, the way a slider cell tracks it: a menu runs its own event loop,
    // and this is the one path that is sure to see every drag event inside it.
    override func mouseDown(with event: NSEvent) {
        set(stop(at: convert(event.locationInWindow, from: nil).x))
        guard let window else { return }
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            if next.type == .leftMouseUp { break }
            set(stop(at: convert(next.locationInWindow, from: nil).x))
        }
    }

    override func accessibilityPerformIncrement() -> Bool {
        guard value < stops - 1 else { return false }
        set(value + 1)
        return true
    }

    override func accessibilityPerformDecrement() -> Bool {
        guard value > 0 else { return false }
        set(value - 1)
        return true
    }
}

// A round symbol button: dim until the pointer reaches it, a disc under it while hovered, and
// nothing when disabled. Every one has a label for VoiceOver and a tooltip for the rest of us.
@MainActor
final class IconButton: NSView {
    var onPress: () -> Void = {}
    var isEnabled = true { didSet { tint() } }
    private var hovering = false { didSet { tint() } }
    private var pressed = false { didSet { needsDisplay = true } }
    private let icon = NSImageView()

    init(symbol: String, label: String, tip: String) {
        super.init(frame: .zero)
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?.withSymbolConfiguration(MenuMetrics.symbol)
        icon.imageAlignment = .alignCenter
        addSubview(icon)
        toolTip = tip
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(label)
        tint()
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func layout() {
        super.layout()
        icon.frame = bounds
    }

    private func tint() {
        icon.contentTintColor = !isEnabled ? .quaternaryLabelColor : hovering ? .labelColor : MenuMetrics.dimText
        setAccessibilityEnabled(isEnabled)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard isEnabled, hovering else { return }
        (pressed ? MenuMetrics.tilePressed : MenuMetrics.tileHover).setFill()
        NSBezierPath(ovalIn: bounds).fill()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        pressed = false
    }

    override func mouseDown(with event: NSEvent) { pressed = isEnabled }

    override func mouseUp(with event: NSEvent) {
        guard pressed else { return }
        pressed = false
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onPress() }
    }

    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        onPress()
        return true
    }
}

// MARK: - Design grid

// Each design as a picture of itself, four to a row, like the wallpaper grid in System
// Settings: the one shown has the accent ring, the one under the pointer a quiet ring, and the
// status tile names whichever is under the pointer. Choosing one keeps the menu open, so the
// wallpaper can be watched changing behind it.
@MainActor
final class DesignGridView: TileView {
    static let columns = 4
    private static let thumbWidth = ((MenuMetrics.content - 2 * MenuMetrics.inset - CGFloat(columns - 1) * MenuMetrics.gap) / CGFloat(columns)).rounded(.down)
    // The aspect of the 1512 x 982 pt display the designs are drawn for.
    private static let thumbHeight = (thumbWidth / 1.54).rounded()

    var onChoose: (String) -> Void = { _ in }
    var onPreview: (String?) -> Void = { _ in }

    private var tiles: [DesignTileView] = []
    private let empty = label(MenuMetrics.smallFont, MenuMetrics.dimText)
    private var current: String?

    override var isInteractive: Bool { false }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: 100))
        empty.alignment = .center
        empty.lineBreakMode = .byTruncatingMiddle
        addSubview(empty)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    // The tile's own frame, inside the menu item's view this also is: the gutter above and the
    // edges beside are part of the view, so the fill is drawn on the tile's rect only.
    private var tile: NSRect {
        NSRect(x: MenuMetrics.edge, y: 0, width: MenuMetrics.content, height: bounds.height - MenuMetrics.gap)
    }

    override var shape: NSBezierPath { NSBezierPath(roundedRect: tile, xRadius: MenuMetrics.tileRadius, yRadius: MenuMetrics.tileRadius) }

    func rebuild(_ designs: [MenuState.DesignEntry], current: String?, folder: String) {
        for tile in tiles { tile.removeFromSuperview() }
        onPreview(nil)
        tiles = designs.map { design in
            let tile = DesignTileView(design, picture: DesignPictures.image(design.id))
            tile.onChoose = { [weak self] in self?.onChoose($0) }
            tile.onHover = { [weak self, weak tile] inside in
                guard let self, let tile else { return }
                if inside { self.onPreview(tile.design.name) } else if self.tiles.contains(where: \.hovering) == false { self.onPreview(nil) }
            }
            return tile
        }
        let rows = (tiles.count + Self.columns - 1) / Self.columns
        let inset = MenuMetrics.inset, gap = MenuMetrics.gap
        let height = rows == 0 ? 40 : CGFloat(rows) * Self.thumbHeight + CGFloat(rows - 1) * gap + 2 * inset
        setFrameSize(NSSize(width: MenuMetrics.width, height: height + gap))
        for (i, tile) in tiles.enumerated() {
            let row = i / Self.columns, column = i % Self.columns
            let x = MenuMetrics.edge + inset + CGFloat(column) * (Self.thumbWidth + gap)
            let y = height - inset - CGFloat(row + 1) * Self.thumbHeight - CGFloat(row) * gap
            tile.frame = NSRect(x: x, y: y, width: Self.thumbWidth, height: Self.thumbHeight)
            addSubview(tile)
        }
        empty.isHidden = !designs.isEmpty
        empty.stringValue = designs.isEmpty ? "No designs in \(folder)" : ""
        empty.frame = NSRect(x: MenuMetrics.edge + inset, y: (height - 15) / 2, width: MenuMetrics.content - 2 * inset, height: 15)
        update(current: current)
    }

    func update(current: String?) {
        self.current = current
        for tile in tiles { tile.isCurrent = tile.design.id == current }
    }

    func clearHover() {
        for tile in tiles { tile.hovering = false }
        onPreview(nil)
    }
}

@MainActor
final class DesignTileView: NSView {
    private static let radius = MenuMetrics.innerRadius
    private static let ringGap: CGFloat = 1.5
    private static let ringWidth: CGFloat = 2

    let design: MenuState.DesignEntry
    private let picture: NSImage?
    var onChoose: (String) -> Void = { _ in }
    var onHover: (Bool) -> Void = { _ in }
    var isCurrent = false { didSet { if isCurrent != oldValue { needsDisplay = true; setAccessibilityValue(isCurrent) } } }
    var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }
    private var pressed = false { didSet { needsDisplay = true } }

    init(_ design: MenuState.DesignEntry, picture: NSImage?) {
        self.design = design
        self.picture = picture
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.radioButton)
        setAccessibilityLabel(design.name)
        setAccessibilityValue(false)
        setAccessibilityEnabled(design.hasPage)
        toolTip = design.hasPage ? design.name : "\(design.name): no index.html yet"
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    // The rings are drawn outside the tile.
    override var wantsDefaultClipping: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds, xRadius: Self.radius, yRadius: Self.radius)
        NSGraphicsContext.saveGraphicsState()
        shape.addClip()
        if let picture {
            picture.draw(in: Self.aspectFill(picture.size, in: bounds), from: .zero, operation: .sourceOver,
                         fraction: design.hasPage ? 1 : 0.35)
        } else {
            MenuMetrics.pill.setFill()
            bounds.fill()
            if let symbol = NSImage(systemSymbolName: "photo", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 13, weight: .regular)) {
                let tinted = symbol.tinted(.tertiaryLabelColor)
                let size = symbol.size
                tinted.draw(in: NSRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2,
                                       width: size.width, height: size.height))
            }
        }
        if pressed {
            NSColor.black.withAlphaComponent(0.18).setFill()
            bounds.fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        // A hairline so a dark picture keeps its edge on a dark tile.
        MenuMetrics.hairline.setStroke()
        let edge = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.25, dy: 0.25), xRadius: Self.radius - 0.25, yRadius: Self.radius - 0.25)
        edge.lineWidth = 0.5
        edge.stroke()

        let ringColour: NSColor? = isCurrent ? .controlAccentColor : (hovering && design.hasPage) ? MenuMetrics.dimText : nil
        if let ringColour {
            let offset = Self.ringGap + Self.ringWidth / 2
            let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: -offset, dy: -offset),
                                    xRadius: Self.radius + offset, yRadius: Self.radius + offset)
            ring.lineWidth = Self.ringWidth
            ringColour.setStroke()
            ring.stroke()
        }
    }

    private static func aspectFill(_ size: NSSize, in rect: NSRect) -> NSRect {
        guard size.width > 0, size.height > 0 else { return rect }
        let scale = Swift.max(rect.width / size.width, rect.height / size.height)
        let w = size.width * scale, h = size.height * scale
        return NSRect(x: rect.midX - w / 2, y: rect.midY - h / 2, width: w, height: h)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        onHover(true)
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        pressed = false
        onHover(false)
    }

    override func mouseDown(with event: NSEvent) {
        if design.hasPage { pressed = true }
    }

    override func mouseUp(with event: NSEvent) {
        guard pressed else { return }
        pressed = false
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onChoose(design.id) }
    }

    override func accessibilityPerformPress() -> Bool {
        guard design.hasPage else { return false }
        onChoose(design.id)
        return true
    }
}

// MARK: - Toggles

// A setting as a Control Center tile: symbol above a one-word title, the accent filling it
// while on. The ink on the accent is black or white by measured contrast (MenuMetrics.ink), so
// a green or yellow accent stays readable. A click anywhere on the tile flips it.
@MainActor
final class ToggleTileView: TileView {
    var onToggle: (Bool) -> Void = { _ in }
    var isOn = false {
        didSet {
            setAccessibilityValue(isOn)
            needsDisplay = true
            tint()
        }
    }

    private let icon = NSImageView()
    private let title = label(MenuMetrics.labelFont, .labelColor)

    init(symbol: String, title: String, label: String, tip: String? = nil) {
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.quarter, height: MenuMetrics.quarter))
        let inset = MenuMetrics.inset + 2
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 16, weight: .medium))
        icon.imageAlignment = .alignLeft
        icon.frame = NSRect(x: inset, y: bounds.height - inset - 20, width: bounds.width - 2 * inset, height: 20)
        self.title.stringValue = title
        self.title.frame = NSRect(x: inset - 2, y: inset - 1, width: bounds.width - 2 * inset + 4, height: 15)
        self.title.lineBreakMode = .byTruncatingTail
        addSubview(icon)
        addSubview(self.title)
        toolTip = tip ?? label
        setAccessibilityElement(true)
        setAccessibilityRole(.checkBox)
        setAccessibilityLabel(label)
        setAccessibilityValue(false)
        tint()
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override var fillColour: NSColor {
        guard isOn else { return super.fillColour }
        let accent = NSColor.controlAccentColor
        return pressed ? accent.blended(withFraction: 0.18, of: .black) ?? accent
            : hovering ? accent.blended(withFraction: 0.08, of: .black) ?? accent : accent
    }

    private func tint() {
        var ink = NSColor.labelColor
        if isOn { effectiveAppearance.performAsCurrentDrawingAppearance { ink = MenuMetrics.ink(on: .controlAccentColor) } }
        icon.contentTintColor = ink
        title.textColor = ink
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        tint()
    }

    override func mouseDown(with event: NSEvent) { pressed = true }

    override func mouseUp(with event: NSEvent) {
        guard pressed else { return }
        pressed = false
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        isOn.toggle()
        onToggle(isOn)
    }

    override func accessibilityPerformPress() -> Bool {
        isOn.toggle()
        onToggle(isOn)
        return true
    }
}

// MARK: - Footer

// The rare actions as symbol buttons on the trailing edge, where a menu's key equivalents sit.
@MainActor
final class FooterView: NSView {
    let reload = IconButton(symbol: "arrow.clockwise", label: "Reload page", tip: "Reload page")
    let folder = IconButton(symbol: "folder", label: "Open page folder", tip: "Open page folder")
    let quit = IconButton(symbol: "xmark.square", label: "Quit KilnWall", tip: "Quit KilnWall  ⌘Q")

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.content, height: 24))
        for (i, button) in [quit, folder, reload].enumerated() {
            button.frame = NSRect(x: bounds.width - 24 - CGFloat(i) * 28, y: 0, width: 24, height: 24)
            addSubview(button)
        }
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }
}

// MARK: - Design pictures

// A small picture of each design for the grid, ~/Library/Application Support/KilnWall/
// design-pictures/<id>.jpg, cut from the desktop snapshots the wallpaper already takes (Desktop.swift): the
// design being shown has its picture refreshed from the newest snapshot of it, so every design
// that has been on screen has one. Pictures are 336 px wide, over twice the widest tile.
enum DesignPictures {
    nonisolated static let folder = KilnSupport.folder.appendingPathComponent("design-pictures", isDirectory: true)
    nonisolated private static let pixels = 336
    @MainActor private static var cache: [String: (date: Date, image: NSImage)] = [:]

    nonisolated static func url(_ id: String) -> URL { folder.appendingPathComponent("\(id).jpg") }

    nonisolated static func modified(_ url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    }

    @MainActor
    static func image(_ id: String) -> NSImage? {
        let url = url(id)
        guard let date = modified(url) else { return nil }
        if let hit = cache[id], hit.date == date { return hit.image }
        guard let image = NSImage(contentsOf: url) else { return nil }
        cache[id] = (date, image)
        return image
    }

    // Cut from `snapshot` and written for `id`, unless the one on disk is as new. True if written.
    @MainActor
    @discardableResult
    static func refresh(_ id: String, from snapshot: URL) -> Bool {
        guard let taken = modified(snapshot) else { return false }
        if let have = modified(url(id)), have >= taken { return false }
        guard let source = CGImageSourceCreateWithURL(snapshot as CFURL, nil),
              let small = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceThumbnailMaxPixelSize: pixels,
                  kCGImageSourceCreateThumbnailWithTransform: true,
              ] as CFDictionary)
        else { return false }
        // Into a new file renamed over the old, so a reader never sees half a picture.
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let temporary = folder.appendingPathComponent(".\(id)-\(UUID().uuidString).jpg")
        guard let destination = CGImageDestinationCreateWithURL(temporary as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { return false }
        CGImageDestinationAddImage(destination, small, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination),
              (try? FileManager.default.replaceItemAt(url(id), withItemAt: temporary)) != nil
        else {
            try? FileManager.default.removeItem(at: temporary)
            return false
        }
        return true
    }
}

// MARK: - Plumbing

@MainActor
private func label(_ font: NSFont, _ colour: NSColor) -> NSTextField {
    let field = NSTextField(labelWithString: "")
    field.font = font
    field.textColor = colour
    return field
}

extension NSImage {
    // A template symbol drawn in one colour, for drawing outside an image view.
    @MainActor
    func tinted(_ colour: NSColor) -> NSImage {
        NSImage(size: size, flipped: false) { rect in
            self.draw(in: rect)
            colour.set()
            rect.fill(using: .sourceIn)
            return true
        }
    }
}
