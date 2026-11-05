// The menu-bar menu. main.swift owns the state and the actions; this builds the menu, keeps it
// current while it is open, and draws its own rows: the status header on Liquid Glass, the
// refresh-period slider, the design grid, the appearance control and the two switches. The rest
// are native items, the temperature unit's submenu among them.
//
// The custom rows line up with the native ones by AppKit's own numbers, measured offscreen from
// its menu item views on macOS 26.6 (tools/menu-render renders the whole menu that way,
// light and dark): items 24 pt high; with no item showing a checkmark, symbols in a 16 pt
// column at x 16 (13 pt, scale .small), titles at x 36, section headers at x 14 in 11 pt
// semibold, separators and key equivalents ending 16 pt from the right; the selection is inset
// 5 pt from each side. A text field draws its glyphs 2 pt inside its frame, so a label framed
// at x 36 starts where a native title does.
import AppKit
import ImageIO
import UniformTypeIdentifiers

enum MenuMetrics {
    static let width: CGFloat = 308
    static let edge: CGFloat = 16  // separators, the symbol column's left, trailing content's right
    static let iconWidth: CGFloat = 16
    static let titleX: CGFloat = 36
    static let headerX: CGFloat = 14
    static let selectionInset: CGFloat = 5
    static let row: CGFloat = 24
    static let symbol = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular, scale: .small)
    static let titleFont = NSFont.menuFont(ofSize: 0)
    static let headerFont = NSFont.systemFont(ofSize: 11, weight: .semibold)
    static let smallFont = NSFont.systemFont(ofSize: 11)
    // Secondary text. secondaryLabelColor measured too faint for 11 pt on the menu (2026-11-05,
    // palmath over #F6F6F6 / #2C2C2E and the card a shade off): WCAG 3.89 in light, APCA Lc 46
    // in dark. These give 5.6:1 / Lc 75 in light and 6.4:1 / Lc 63 in dark, still a clear step
    // below the titles.
    static let dimText = NSColor(name: "KilnMenuDim") { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.70) : NSColor(white: 0, alpha: 0.60)
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

    private let header = StatusHeaderView()
    private let period: PeriodControlView
    private let grid = DesignGridView()
    private let appearanceRow = AppearanceControlView()
    // Temperature: a native submenu, the menu's own dropdown (a pop-up button inside a menu
    // would be a menu tracking inside another), with the unit in use as the row's subtitle.
    private let tempItem = NSMenuItem()
    private let unitItems: [TempUnit: NSMenuItem] = Dictionary(uniqueKeysWithValues: TempUnit.allCases.map { unit in
        (unit, NSMenuItem(title: unit.menuTitle, action: nil, keyEquivalent: ""))
    })
    private let matchRow = SwitchRowView(title: "Match macOS Wallpaper", symbol: "photo.on.rectangle")
    private let loginRow = SwitchRowView(title: "Launch at Login", symbol: "power")
    private let pauseItem = NSMenuItem()
    private let showItem = NSMenuItem()
    private let gridItem = NSMenuItem()
    private var lastBeat = Date.distantPast

    init(min: Int, max: Int, step: Int, state: @escaping () -> MenuState) {
        self.state = state
        period = PeriodControlView(min: min, max: max, step: step)
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false

        add(header)
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "Refresh"))
        add(period)
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "Design"))
        gridItem.view = grid
        menu.addItem(gridItem)
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "Appearance"))
        add(appearanceRow)
        let units = NSMenu()
        for unit in TempUnit.allCases {
            let item = unitItems[unit]!
            item.action = #selector(unitChosen(_:))
            item.target = self
            item.representedObject = unit.rawValue
            units.addItem(item)
        }
        tempItem.title = "Temperature"
        tempItem.image = NSImage(systemSymbolName: "thermometer.medium", accessibilityDescription: nil)
        tempItem.submenu = units
        menu.addItem(tempItem)
        menu.addItem(.separator())
        configure(pauseItem, "Pause", "pause", #selector(pauseChosen))
        configure(showItem, "Hide Wallpaper", "eye.slash", #selector(showChosen))
        configure(NSMenuItem(), "Reload Page", "arrow.clockwise", #selector(reloadChosen))
        configure(NSMenuItem(), "Open Page Folder", "folder", #selector(folderChosen))
        menu.addItem(.separator())
        add(matchRow)
        add(loginRow)
        menu.addItem(.separator())
        // terminate: itself, so macOS 26 gives Quit its standard symbol.
        let quit = menu.addItem(withTitle: "Quit KilnWall", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp

        period.onChange = { [weak self] in self?.setPeriod($0) }
        period.onStep = { [weak self] in self?.stepPeriod($0) }
        grid.onChoose = { [weak self] in self?.chooseDesign($0) }
        appearanceRow.onChange = { [weak self] in self?.setAppearance($0) }
        matchRow.onToggle = { [weak self] in self?.setMatchDesktop($0) }
        loginRow.onToggle = { [weak self] on in
            guard let self else { return }
            let now = self.setLaunchAtLogin(on)
            self.loginRow.isOn = now
        }
    }

    private func add(_ view: NSView) {
        let item = NSMenuItem()
        item.view = view
        menu.addItem(item)
    }

    private func configure(_ item: NSMenuItem, _ title: String, _ symbol: String, _ action: Selector) {
        item.title = title
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        item.action = action
        item.target = self
        menu.addItem(item)
    }

    @objc private func pauseChosen() { togglePause() }
    @objc private func showChosen() { toggleShown() }
    @objc private func reloadChosen() { reloadPage() }
    @objc private func folderChosen() { openPageFolder() }
    @objc private func unitChosen(_ sender: NSMenuItem) {
        if let unit = (sender.representedObject as? String).flatMap(TempUnit.init(rawValue:)) { setTempUnit(unit) }
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
        header.update(now)
        period.update(periodMs: now.periodMs)
        grid.update(current: now.currentDesign)
        appearanceRow.update(now.appearance)
        for (unit, item) in unitItems { item.state = unit == now.tempUnit ? .on : .off }
        if #available(macOS 14.4, *) { tempItem.subtitle = now.tempUnit.menuTitle }
        matchRow.isOn = now.matchDesktop
        loginRow.isOn = now.launchAtLogin
        pauseItem.title = now.pausedByYou ? "Resume" : "Pause"
        pauseItem.image = NSImage(systemSymbolName: now.pausedByYou ? "play" : "pause", accessibilityDescription: nil)
        showItem.title = now.hidden ? "Show Wallpaper" : "Hide Wallpaper"
        showItem.image = NSImage(systemSymbolName: now.hidden ? "eye" : "eye.slash", accessibilityDescription: nil)
    }

    // A line reached the page: the status light pulses, at most every 0.6 s so a 100 ms feed
    // does not flicker.
    func beat() {
        guard isOpen, Date().timeIntervalSince(lastBeat) >= 0.6 else { return }
        lastBeat = Date()
        header.beat()
    }
}

// MARK: - Status header

// The design shown, the period, the state and the feed, on a Liquid Glass card inset like the
// menu's own selection. The light sits in the symbol column and the text on the title column.
@MainActor
final class StatusHeaderView: NSView {
    private static let cardHeight: CGFloat = 64
    private let light = StatusLight()
    private let name = label(NSFont.systemFont(ofSize: 15, weight: .semibold), .labelColor)
    private let period = label(NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium), MenuMetrics.dimText)
    private let stateLine = label(NSFont.systemFont(ofSize: 11, weight: .medium), MenuMetrics.dimText)
    private let feedLine = label(MenuMetrics.smallFont, MenuMetrics.dimText)

    init() {
        let inset = MenuMetrics.selectionInset
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: Self.cardHeight + 4))
        // The menu's 5 pt top padding above, 4 pt below: the card sits 5 pt from three edges.
        let card = NSRect(x: inset, y: 4, width: MenuMetrics.width - 2 * inset, height: Self.cardHeight)
        let content = NSView(frame: NSRect(origin: .zero, size: card.size))
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView(frame: card)
            glass.cornerRadius = 10
            glass.contentView = content
            addSubview(glass)
        } else {
            let plate = PlateView(frame: card)
            plate.addSubview(content)
            addSubview(plate)
        }
        // Card-local x: the menu's columns minus the card's inset.
        let titleX = MenuMetrics.titleX - inset
        let right = card.width - (MenuMetrics.edge - inset)
        // Measured on the render: 10.5 pt from the card's top to the name's cap height and from
        // the last baseline to its bottom. A right-aligned field ends 2 pt past its glyphs.
        light.frame = NSRect(x: MenuMetrics.edge - inset - 4, y: 36, width: MenuMetrics.iconWidth + 8, height: 24)
        name.frame = NSRect(x: titleX, y: 38, width: right - titleX - 64, height: 19)
        name.lineBreakMode = .byTruncatingTail
        period.frame = NSRect(x: right - 62, y: 39, width: 64, height: 16)
        period.alignment = .right
        stateLine.frame = NSRect(x: titleX, y: 22, width: right - titleX, height: 14)
        stateLine.lineBreakMode = .byTruncatingTail
        feedLine.frame = NSRect(x: titleX, y: 7, width: right - titleX, height: 14)
        feedLine.lineBreakMode = .byTruncatingMiddle
        for view in [light, name, period, stateLine, feedLine] as [NSView] { content.addSubview(view) }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func update(_ state: MenuState) {
        name.stringValue = state.designName
        period.stringValue = "\(state.periodMs) ms"
        stateLine.stringValue = state.stateText
        stateLine.toolTip = state.stateText
        feedLine.stringValue = state.feedText
        feedLine.toolTip = state.feedText
        light.state = state.light
        setAccessibilityLabel("\(state.designName), every \(state.periodMs) ms. \(state.stateText). \(state.feedText)")
    }

    func beat() { light.beat() }
}

// Green running, grey under a cover (the feed held), orange paused for any other reason. The
// state line beside it says which in words; the colour is never the only signal.
@MainActor
final class StatusLight: NSView {
    private static let diameter: CGFloat = 8
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

// Before macOS 26 (no Liquid Glass): a quiet rounded plate in place of the glass card.
@MainActor
private final class PlateView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.quaternaryLabelColor.withAlphaComponent(0.08).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10).fill()
    }
}

// MARK: - Refresh period

// Left is slower, right is faster, as ⌃⌥- and ⌃⌥= move it (like btop, "+" is faster): the
// tortoise end is 1000 ms, the hare end 100 ms. Ten stops; every stop the slider passes is
// applied at once, through the same path as the hotkeys. The period itself reads in the header
// just above, so this row carries only the keys.
@MainActor
final class PeriodControlView: NSView {
    var onChange: (Int) -> Void = { _ in }
    var onStep: (Int) -> Void = { _ in }

    private let min: Int, max: Int, step: Int
    private let slider = NSSlider()
    private let slower = SymbolButton(symbol: "tortoise", label: "Slower")
    private let faster = SymbolButton(symbol: "hare", label: "Faster")
    private let slowerKeys = label(MenuMetrics.smallFont, MenuMetrics.dimText)
    private let fasterKeys = label(MenuMetrics.smallFont, MenuMetrics.dimText)
    private var current = 0

    init(min: Int, max: Int, step: Int) {
        self.min = min
        self.max = max
        self.step = step
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: 48))
        let edge = MenuMetrics.edge, w = MenuMetrics.width, icon = MenuMetrics.iconWidth
        slower.frame = NSRect(x: edge, y: 24, width: icon, height: 20)
        faster.frame = NSRect(x: w - edge - icon, y: 24, width: icon, height: 20)
        slider.frame = NSRect(x: edge + icon + 8, y: 24, width: w - 2 * (edge + icon + 8), height: 20)
        slider.minValue = 0
        slider.maxValue = Double(stops - 1)
        slider.numberOfTickMarks = stops
        slider.allowsTickMarkValuesOnly = true
        slider.isContinuous = true
        slider.target = self
        slider.action = #selector(slid)
        slider.setAccessibilityLabel("Refresh period")
        slower.target = self
        slower.action = #selector(slowerChosen)
        faster.target = self
        faster.action = #selector(fasterChosen)
        // Each hint starts under the button it matches.
        slowerKeys.stringValue = "⌃⌥−  Slower"
        fasterKeys.stringValue = "Faster  ⌃⌥="
        slowerKeys.frame = NSRect(x: edge - 2, y: 6, width: 100, height: 14)
        fasterKeys.frame = NSRect(x: w - edge - 98, y: 6, width: 100, height: 14)
        fasterKeys.alignment = .right
        slowerKeys.setAccessibilityLabel("Slower: Control Option Minus")
        fasterKeys.setAccessibilityLabel("Faster: Control Option Equals")
        for view in [slower, slider, faster, slowerKeys, fasterKeys] as [NSView] { addSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    private var stops: Int { (max - min) / step + 1 }
    private func ms(at stop: Int) -> Int { max - stop * step }
    private func stop(for ms: Int) -> Int { (max - ms) / step }

    func update(periodMs: Int) {
        current = periodMs
        // Not while it is being dragged to this very stop: setting it would fight the drag.
        if Int(slider.doubleValue.rounded()) != stop(for: periodMs) {
            slider.doubleValue = Double(stop(for: periodMs))
        }
        slider.setAccessibilityValueDescription("\(periodMs) ms")
        slower.isEnabled = periodMs < max
        faster.isEnabled = periodMs > min
    }

    @objc private func slid() {
        let ms = ms(at: Int(slider.doubleValue.rounded()))
        guard ms != current else { return }
        current = ms
        slider.setAccessibilityValueDescription("\(ms) ms")
        onChange(ms)
    }

    @objc private func slowerChosen() { onStep(step) }
    @objc private func fasterChosen() { onStep(-step) }
}

// A borderless symbol button that brightens under the pointer. Menus never make the app active,
// so the tracking area must be active always.
@MainActor
final class SymbolButton: NSButton {
    private var hovering = false { didSet { tint() } }

    init(symbol: String, label: String) {
        super.init(frame: .zero)
        image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(MenuMetrics.symbol)
        imagePosition = .imageOnly
        isBordered = false
        bezelStyle = .regularSquare
        setButtonType(.momentaryChange)
        toolTip = label
        tint()
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override var isEnabled: Bool { didSet { tint() } }

    private func tint() {
        contentTintColor = !isEnabled ? .tertiaryLabelColor : hovering ? .labelColor : MenuMetrics.dimText
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
}

// MARK: - Design grid

// Each design as a picture of itself, three to a row, like the wallpaper grid in System
// Settings: the one shown has the accent ring, the one under the pointer a quiet ring, and
// the line below names whichever is under the pointer, else the one shown. Choosing one keeps
// the menu open, so the wallpaper can be watched changing behind it.
@MainActor
final class DesignGridView: NSView {
    static let columns = 3
    static let gap: CGFloat = 12
    private static let tileWidth = (MenuMetrics.width - 2 * MenuMetrics.edge - CGFloat(columns - 1) * gap) / CGFloat(columns)
    // The aspect of the 1512 x 982 pt display the designs are drawn for.
    private static let tileHeight = (tileWidth / 1.54).rounded()

    var onChoose: (String) -> Void = { _ in }

    private var tiles: [DesignTileView] = []
    private let caption = label(MenuMetrics.titleFont, MenuMetrics.dimText)
    private var current: String?
    private var hovered: DesignTileView? { didSet { updateCaption() } }
    private var emptyText: String?

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: 100))
        caption.lineBreakMode = .byTruncatingMiddle
        addSubview(caption)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func rebuild(_ designs: [MenuState.DesignEntry], current: String?, folder: String) {
        for tile in tiles { tile.removeFromSuperview() }
        hovered = nil
        tiles = designs.map { design in
            let tile = DesignTileView(design, picture: DesignPictures.image(design.id))
            tile.onChoose = { [weak self] in self?.onChoose($0) }
            tile.onHover = { [weak self, weak tile] inside in
                guard let self, let tile else { return }
                if inside { self.hovered = tile } else if self.hovered === tile { self.hovered = nil }
            }
            return tile
        }
        emptyText = designs.isEmpty ? "No designs in \(folder)" : nil
        let rows = (tiles.count + Self.columns - 1) / Self.columns
        // 6 pt above the first row for its ring; the caption is one native row, its text 12 pt
        // under the tiles like the rows' own gap.
        let gridHeight = rows == 0 ? 0 : CGFloat(rows) * Self.tileHeight + CGFloat(rows - 1) * Self.gap + 6
        let captionTop = rows == 0 ? 0 : gridHeight + 4
        setFrameSize(NSSize(width: MenuMetrics.width, height: captionTop + MenuMetrics.row))
        for (i, tile) in tiles.enumerated() {
            let row = i / Self.columns, column = i % Self.columns
            let x = MenuMetrics.edge + CGFloat(column) * (Self.tileWidth + Self.gap)
            let y = frame.height - 6 - CGFloat(row + 1) * Self.tileHeight - CGFloat(row) * Self.gap
            tile.frame = NSRect(x: x, y: y, width: Self.tileWidth, height: Self.tileHeight)
            addSubview(tile)
        }
        caption.frame = NSRect(x: MenuMetrics.edge - 2, y: 4, width: MenuMetrics.width - 2 * MenuMetrics.edge + 4, height: 16)
        update(current: current)
    }

    func update(current: String?) {
        self.current = current
        for tile in tiles { tile.isCurrent = tile.design.id == current }
        updateCaption()
    }

    func clearHover() {
        for tile in tiles { tile.hovering = false }
        hovered = nil
    }

    private func updateCaption() {
        if let emptyText {
            caption.stringValue = emptyText
            caption.textColor = MenuMetrics.dimText
        } else if let hovered {
            let design = hovered.design
            caption.stringValue = design.hasPage ? design.name : "\(design.name) (no index.html yet)"
            caption.textColor = .labelColor
        } else {
            caption.stringValue = tiles.first { $0.design.id == current }?.design.name ?? ""
            caption.textColor = MenuMetrics.dimText
        }
    }
}

@MainActor
final class DesignTileView: NSView {
    private static let radius: CGFloat = 6
    private static let ringGap: CGFloat = 2
    private static let ringWidth: CGFloat = 2.5

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
            NSColor.quaternarySystemFill.setFill()
            bounds.fill()
            if let symbol = NSImage(systemSymbolName: "photo", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 15, weight: .regular)) {
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
        // A hairline so a dark picture keeps its edge on a dark menu.
        NSColor.separatorColor.setStroke()
        let edge = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.25, dy: 0.25), xRadius: Self.radius - 0.25, yRadius: Self.radius - 0.25)
        edge.lineWidth = 0.5
        edge.stroke()

        let ringColour: NSColor? = isCurrent ? .controlAccentColor : (hovering && design.hasPage) ? .secondaryLabelColor : nil
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

// MARK: - Appearance

// Auto (the design's own day/night rule, which follows the sun), Light or Dark: one segmented
// control across the content columns (16 pt from each edge, like the slider row's buttons), with
// a line under it saying what the choice does, where the slider row has its key hints. Each
// choice applies live and the menu stays open, so the wallpaper can be watched changing.
@MainActor
final class AppearanceControlView: NSView {
    var onChange: (Appearance) -> Void = { _ in }

    private static let choices: [(appearance: Appearance, label: String, symbol: String, hint: String)] = [
        (.auto, "Auto", "circle.lefthalf.filled", "Day look by day, night look after sunset"),
        (.light, "Light", "sun.max", "The day look, always"),
        (.dark, "Dark", "moon", "The night look, always"),
    ]
    private let control = NSSegmentedControl()
    private let hint = label(MenuMetrics.smallFont, MenuMetrics.dimText)
    private var current: Appearance?

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: 56))
        let edge = MenuMetrics.edge, w = MenuMetrics.width
        control.segmentCount = Self.choices.count
        control.trackingMode = .selectOne
        control.segmentDistribution = .fillEqually
        for (i, choice) in Self.choices.enumerated() {
            control.setImage(NSImage(systemSymbolName: choice.symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(MenuMetrics.symbol), forSegment: i)
            control.setImageScaling(.scaleNone, forSegment: i)
            control.setLabel(choice.label, forSegment: i)
            control.setToolTip(choice.hint, forSegment: i)
        }
        control.target = self
        control.action = #selector(chosen)
        control.setAccessibilityLabel("Appearance")
        // 24 pt on macOS 26 (measured, tools/menu-render): 4 pt under the section header like the
        // slider, the hint where the slider row's hints sit, 8 pt between them. Row 56 = 7 x 8.
        let height = control.fittingSize.height
        control.frame = NSRect(x: edge, y: 52 - height, width: w - 2 * edge, height: height)
        hint.frame = NSRect(x: edge - 2, y: 6, width: w - 2 * edge + 4, height: 14)
        hint.lineBreakMode = .byTruncatingTail
        addSubview(control)
        addSubview(hint)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func update(_ appearance: Appearance) {
        current = appearance
        guard let i = Self.choices.firstIndex(where: { $0.appearance == appearance }) else { return }
        if control.selectedSegment != i { control.selectedSegment = i }
        hint.stringValue = Self.choices[i].hint
    }

    @objc private func chosen() {
        guard Self.choices.indices.contains(control.selectedSegment) else { return }
        let choice = Self.choices[control.selectedSegment]
        hint.stringValue = choice.hint
        guard choice.appearance != current else { return }
        current = choice.appearance
        onChange(choice.appearance)
    }
}

extension TempUnit {
    var menuTitle: String {
        switch self {
        case .fahrenheit: "°F Fahrenheit"
        case .celsius: "°C Celsius"
        }
    }
}

// MARK: - Switch rows

// A setting as a switch, the way macOS 26's own menu-bar menus show them: symbol and title on
// the native columns, the switch on the trailing edge. A click anywhere on the row flips it.
@MainActor
final class SwitchRowView: NSView {
    var onToggle: (Bool) -> Void = { _ in }
    private let toggle = NSSwitch()

    var isOn: Bool {
        get { toggle.state == .on }
        set { toggle.state = newValue ? .on : .off }
    }

    init(title: String, symbol: String) {
        super.init(frame: NSRect(x: 0, y: 0, width: MenuMetrics.width, height: 28))
        let icon = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(MenuMetrics.symbol) ?? NSImage())
        icon.contentTintColor = .labelColor
        icon.frame = NSRect(x: MenuMetrics.edge, y: 6, width: MenuMetrics.iconWidth, height: 16)
        icon.imageAlignment = .alignCenter
        let text = label(MenuMetrics.titleFont, .labelColor)
        text.stringValue = title
        toggle.controlSize = .small
        toggle.target = self
        toggle.action = #selector(flipped)
        toggle.setAccessibilityLabel(title)
        // On macOS 26 a switch's fittingSize is 54 x 24 at every control size and a small one
        // draws 44 x 20 centred in it, so its frame is set to what it draws: it then ends on
        // the trailing edge like the key equivalents.
        toggle.frame = NSRect(x: MenuMetrics.width - MenuMetrics.edge - 44, y: 4, width: 44, height: 20)
        text.frame = NSRect(x: MenuMetrics.titleX, y: 6, width: toggle.frame.minX - 8 - MenuMetrics.titleX, height: 16)
        for view in [icon, text, toggle] as [NSView] { addSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    @objc private func flipped() { onToggle(isOn) }

    // Taken, so the row gets the mouseUp that flips it.
    override func mouseDown(with event: NSEvent) {}

    override func mouseUp(with event: NSEvent) {
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        isOn.toggle()
        onToggle(isOn)
    }
}

// MARK: - Design pictures

// A small picture of each design for the grid, ~/Library/Application Support/KilnWall/
// design-pictures/<id>.jpg, cut from the desktop snapshots the wallpaper already takes (Desktop.swift): the
// design being shown has its picture refreshed from the newest snapshot of it, so every design
// that has been on screen has one. Pictures are 336 px wide, twice the widest tile.
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
