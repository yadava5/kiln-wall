// Keeps the macOS desktop picture matched to the live wallpaper.
//
// Mission Control, Space switches and the Dock animate the system's desktop picture, not the
// wallpaper window, so whatever picture macOS holds flashes on screen in those transitions
// (recorded 2026-11-05: ~0.4 s entering Mission Control, ~1 frame leaving it). So each display's
// web view is snapshotted now and then and the snapshot set as that display's desktop picture.
// When (main.swift decides, snapshotIfDue): while the wallpaper runs, 8 s after a page load,
// when matching is switched on, and otherwise (on a Space change, the desktop picture being per
// Space, and while the page runs) at most once per 60 s and only if the page was sent a line
// since the last; and once at once, past that throttle, when a new design or appearance has
// painted, also while covered (main.swift draws it unseen for this).
//
// Every picture is tagged with what it shows, its Look (design and the light or dark look it was
// drawn in), in its file name, and is only ever shown as that look: Ayush saw the previous design for "a second or two" on
// returning to the desktop after switching designs (2026-11-05). The host log had it: the desktop
// picture stayed the old design for 168 s after a switch (the after-load snapshot fell under a
// cover), and the overlay over a returning page was "the newest JPEG", of the old design. A
// snapshot is checked against the page when it completes and again before it is set: a page
// that changed meanwhile drops it. Until a picture of a new look exists, the desktop picture is
// the newest older picture of that look, else a plain field of the design's background colour.
//
// The tag is the look as drawn, light or dark, not the menu's choice: "auto" is the design's own
// sun rule, so a picture tagged "auto" said nothing about what it showed, and at 12:31 on
// 2026-11-05 a return found no picture of glass/auto although glass/dark, what auto was showing,
// had one. A forced choice is its own look; an "auto" snapshot is read from its pixels (luma mean
// over 48x30 at or above lightLumaMean: light). main.swift matches "auto" to the look the page
// was last seen to draw it in.
//
// Each snapshot goes to a new file in ~/Library/Application Support/KilnWall/desktop/ (macOS
// caches the picture by URL, so a rewritten file would not be re-read). Kept per display: the
// newest two, the newest of each look (so switching back to a design has its picture at once)
// and the one set. JPEG at quality 0.9: measured 2026-11-05 on a 3024x1964 ledger snapshot,
// median of 7, JPEG 28.7 ms (1.9 MB), PNG 66.5 ms (1.2 MB), HEIC 0.9 68.1 ms (1.2 MB).
//
// The user's own picture is saved per display (OriginalDesktop, settings.json) before the first
// change and put back on Quit and when matching is switched off. A test instance
// (KILNWALL_TEST_HOME) never sets or restores it: it logs what it would have set.
import AppKit
import ImageIO
import UniformTypeIdentifiers
import WebKit

// A design (its folder id, or "_page" for the old page folder or the bundled page; a design id
// never starts with "_") and an appearance. For the page: what it is told (auto, light or dark).
// For a picture: the look it shows, light or dark only.
struct Look: Hashable, CustomStringConvertible {
    let design: String
    let appearance: String
    var description: String { "\(design)/\(appearance)" }
    var isAuto: Bool { appearance == Appearance.auto.rawValue }
}

// One file of the desktop folder: desktop-<display>-<ms>@<design>@<light|dark>[@solid].jpg, the
// design percent-encoded so "@" only separates fields. A file from before the tags
// (desktop-<display>-<ms>.jpg), or tagged "auto" (before 2026-11-05 13:00), has no look and is
// never shown.
struct DesktopPicture {
    let url: URL
    let ms: Int
    let look: Look?
    let solid: Bool

    private static let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))

    static func name(_ display: CGDirectDisplayID, _ look: Look, solid: Bool) -> String {
        let design = look.design.addingPercentEncoding(withAllowedCharacters: safe) ?? "_"
        return "desktop-\(display)-\(Int(Date().timeIntervalSince1970 * 1000))@\(design)@\(look.appearance)"
            + (solid ? "@solid" : "") + ".jpg"
    }

    init?(_ name: String, display: CGDirectDisplayID, in folder: URL) {
        let prefix = "desktop-\(display)-"
        guard name.hasPrefix(prefix), name.hasSuffix(".jpg") else { return nil }
        let fields = name.dropFirst(prefix.count).dropLast(4).split(separator: "@", omittingEmptySubsequences: false).map(String.init)
        guard let ms = Int(fields[0]) else { return nil }
        url = folder.appendingPathComponent(name)
        self.ms = ms
        if fields.count >= 3, let design = fields[1].removingPercentEncoding, !design.isEmpty,
           fields[2] == Appearance.light.rawValue || fields[2] == Appearance.dark.rawValue {
            look = Look(design: design, appearance: fields[2])
        } else {
            look = nil
        }
        solid = fields.count == 4 && fields[3] == "solid"
    }
}

@MainActor
final class DesktopMatcher {
    nonisolated static let folder = KilnSupport.folder.appendingPathComponent("desktop", isDirectory: true)
    nonisolated private static let keep = 2
    nonisolated private static let quality = 0.9
    // A snapshot whose luma varies less than this is a blank page: never written or set.
    nonisolated static let blankLumaStd = 3.0
    // An "auto" snapshot whose luma mean is at least this shows the light look. Measured
    // 2026-11-05 ~13:00 (daytime), headless at 1x, every design forced each way: dark 28.4
    // (flightdeck, its day sky under the dark scrims) to 47.0 (horizon), light 194-224 (glass
    // 195.7, flightdeck 204.4, ledger 209.6, horizon 215.7, missionmap 216.4, bento 224.4), and
    // auto within 1.3 of light for all six.
    nonisolated static let lightLumaMean = 120.0
    private static let snapshotTimeout: TimeInterval = 10

    // A snapshot asked for: a picture of the page told `look` (auto, light or dark), good only
    // while `isCurrent()` says the page still shows it. The file is tagged with the light or dark
    // look it shows. `completion` gets the file written (whether or not it was set), or nil.
    struct Request {
        let reason: String
        let look: Look
        let isCurrent: () -> Bool
        var completion: (URL?) -> Void = { _ in }
    }

    var enabled: Bool
    private let encoder = DispatchQueue(label: "io.github.yadava5.kilnwall.desktop", qos: .utility)
    // One update in flight per display; a request meanwhile is held (the latest) and run after.
    private var inFlight: [CGDirectDisplayID: Int] = [:]
    private var pending: [CGDirectDisplayID: Request] = [:]
    private var serial = 0
    // The file each display's picture was last set to: never pruned.
    private var lastSet: [CGDirectDisplayID: String] = [:]
    private let webViewFor: (CGDirectDisplayID) -> WKWebView?
    private let testInstance = TestHome.url != nil

    init(enabled: Bool, webViewFor: @escaping (CGDirectDisplayID) -> WKWebView?) {
        self.enabled = enabled
        self.webViewFor = webViewFor
    }

    // MARK: Updating

    // Snapshots and writes the file whether or not matching is on (main.swift also lays the newest
    // file of the shown look over a reloading page); only `set` needs `enabled`.
    func update(_ display: CGDirectDisplayID, _ request: Request) {
        guard let webView = webViewFor(display), let screen = Self.screen(display) else { return request.completion(nil) }
        if inFlight[display] != nil {
            pending.updateValue(request, forKey: display)?.completion(nil)
            return
        }
        serial += 1
        let token = serial
        inFlight[display] = token
        let scale = screen.backingScaleFactor
        let points = webView.bounds.size
        let width = Int((points.width * scale).rounded())
        let height = Int((points.height * scale).rounded())
        // WebContent CPU across the snapshot (it also includes whatever the page drew meanwhile).
        let webPID = pid_t(KilnWall.webProcessID(webView))
        let cpuBefore = webPID > 0 ? Headless.cpuSeconds(webPID) : nil
        let started = DispatchTime.now().uptimeNanoseconds
        let look = request.look, reason = request.reason

        DispatchQueue.main.asyncAfter(deadline: .now() + Self.snapshotTimeout) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.inFlight[display] == token else { return }
                log("desktop: display \(display) snapshot of \(look) did not complete within \(Int(Self.snapshotTimeout)) s (\(reason))")
                request.completion(nil)
                self.done(display)
            }
        }

        let configuration = WKSnapshotConfiguration()
        // What is on screen now: no waiting for a presentation update, which a paused or covered
        // page may not make.
        configuration.afterScreenUpdates = false
        webView.takeSnapshot(with: configuration) { [weak self] image, error in
            MainActor.assumeIsolated {
                guard let self, self.inFlight[display] == token else { return }
                let snapshotMs = Self.ms(since: started)
                var webCPU: Double?
                if let before = cpuBefore, let after = Headless.cpuSeconds(webPID) { webCPU = (after - before) * 1000 }
                guard let image, let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                    log("desktop: display \(display) snapshot of \(look) failed: \(error?.localizedDescription ?? "no image") (\(reason))")
                    request.completion(nil)
                    return self.done(display)
                }
                // A switch or an appearance change landed while it was taken: a picture of what?
                guard request.isCurrent() else {
                    log("desktop: display \(display) snapshot of \(look) dropped: the page changed while it was taken (\(reason))")
                    request.completion(nil)
                    return self.done(display)
                }
                log(String(format: "desktop: snapshot display %u of %@ (%@): %dx%d px in %.1f ms, WebContent CPU %@",
                           display, look.description, reason, cgImage.width, cgImage.height, snapshotMs,
                           webCPU.map { String(format: "%.1f ms", $0) } ?? "unknown"))
                let spare = self.lastSet[display]
                self.encoder.async {
                    let encodeStarted = DispatchTime.now().uptimeNanoseconds
                    let result: Result<(url: URL, shown: Look, how: String, bytes: Int, redrawn: Bool), Problem>
                    let stats = Self.lumaStats(cgImage)
                    if let stats, stats.std < Self.blankLumaStd {
                        result = .failure(Problem(message: String(
                            format: "snapshot of %@ refused: blank (luma mean %.1f std %.1f)", look.description, stats.mean, stats.std)))
                    } else if let (shown, how) = Self.shownLook(look, stats) {
                        let url = Self.folder.appendingPathComponent(DesktopPicture.name(display, shown, solid: false))
                        result = Self.write(cgImage, width: width, height: height, to: url).map { (url, shown, how, $0.0, $0.1) }
                    } else {
                        result = .failure(Problem(message: "snapshot of \(look) not written: its luma, which tells auto's look, is unknown"))
                    }
                    let encodeMs = Self.ms(since: encodeStarted)
                    if case .success = result { Self.prune(display, sparing: spare) }
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            guard self.inFlight[display] == token else { return }
                            switch result {
                            case .success(let written):
                                let url = written.url
                                if request.isCurrent() {
                                    self.set(display, url, look: written.shown, reason: reason, detail: String(
                                        format: "%@; %d bytes; JPEG encode + write %.1f ms%@", written.how, written.bytes, encodeMs,
                                        written.redrawn ? " (redrawn to fit)" : ""))
                                } else {
                                    log("desktop: display \(display) wrote \(url.lastPathComponent) but did not set it: the page changed meanwhile (\(reason))")
                                }
                                request.completion(url)
                            case .failure(let problem):
                                log("desktop: display \(display): \(problem.message)")
                                request.completion(nil)
                            }
                            self.done(display)
                        }
                    }
                }
            }
        }
    }

    private func done(_ display: CGDirectDisplayID) {
        inFlight[display] = nil
        if let next = pending.removeValue(forKey: display) { update(display, next) }
    }

    // A picture already on disk (an older snapshot of the look now shown), set at once.
    func setPicture(_ display: CGDirectDisplayID, _ picture: DesktopPicture, reason: String) {
        guard let look = picture.look else { return }
        let age = Double(Int(Date().timeIntervalSince1970 * 1000) - picture.ms) / 1000
        set(display, picture.url, look: look, reason: reason, detail: String(format: "an older picture of it, %.0f s old", age))
    }

    // No picture of the look yet: a plain field of its background colour, never another design.
    // Written off the main thread (64x40 px; macOS fills the screen with it) and set unless the
    // look has changed again by then.
    func setSolid(_ display: CGDirectDisplayID, _ colour: NSColor, look: Look, reason: String, isCurrent: @escaping () -> Bool) {
        guard enabled, Self.screen(display) != nil, let rgb = colour.usingColorSpace(.sRGB) else { return }
        let components = [rgb.redComponent, rgb.greenComponent, rgb.blueComponent]
        let hex = components.map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
        let url = Self.folder.appendingPathComponent(DesktopPicture.name(display, look, solid: true))
        let spare = lastSet[display]
        encoder.async {
            let result = Self.writeSolid(components, to: url)
            if case .success = result { Self.prune(display, sparing: spare) }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    switch result {
                    case .success:
                        guard isCurrent() else { return log("desktop: display \(display) solid for \(look) not set: the page changed meanwhile") }
                        self.set(display, url, look: look, reason: reason, detail: "a solid #\(hex), no picture of it yet")
                    case .failure(let problem):
                        log("desktop: display \(display): \(problem.message)")
                    }
                }
            }
        }
    }

    // Every use of the desktop picture is logged with the look it shows.
    private func set(_ display: CGDirectDisplayID, _ url: URL, look: Look, reason: String, detail: String) {
        // Switched off (or the display went) while the snapshot was being written.
        guard enabled, let screen = Self.screen(display) else { return }
        if testInstance {
            lastSet[display] = url.lastPathComponent
            return log("desktop: test instance, display \(display) NOT set (would be \(url.lastPathComponent), design \(look.design), appearance \(look.appearance); \(detail)) (\(reason))")
        }
        guard saveOriginal(display, screen) else { return }
        let started = DispatchTime.now().uptimeNanoseconds
        do {
            try NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: [
                .imageScaling: NSImageScaling.scaleProportionallyUpOrDown.rawValue,
                .allowClipping: true,
            ])
        } catch {
            return log("desktop: display \(display): cannot set \(url.path): \(error.localizedDescription)")
        }
        lastSet[display] = url.lastPathComponent
        log(String(format: "desktop: set display %u to %@, design %@, appearance %@; %@, set %.1f ms (%@)",
                   display, url.path, look.design, look.appearance, detail, Self.ms(since: started), reason))
    }

    // MARK: The user's own picture

    // Before the first change on a display: false if it could not be saved, so the picture is not
    // replaced with nothing to put back.
    private func saveOriginal(_ display: CGDirectDisplayID, _ screen: NSScreen) -> Bool {
        let key = Self.key(display)
        var originals = OriginalDesktop.loadAll()
        if originals[key] != nil { return true }
        guard let current = NSWorkspace.shared.desktopImageURL(for: screen) else {
            log("desktop: display \(display) reports no desktop picture; nothing to save")
            return true
        }
        if Self.isOurs(current) {
            log("desktop: display \(display) already shows KilnWall's \(current.lastPathComponent); no original to save")
            return true
        }
        let options = NSWorkspace.shared.desktopImageOptions(for: screen) ?? [:]
        let original = OriginalDesktop(display: screen.localizedName, url: current, options: options)
        originals[key] = original
        do {
            try OriginalDesktop.saveAll(originals)
        } catch {
            log("desktop: cannot save the original picture to \(Settings.file.path): \(error.localizedDescription); leaving it")
            return false
        }
        log("desktop: saved display \(display)'s original picture: \(current.absoluteString) \(Self.describe(original))")
        return true
    }

    // Puts each display's saved picture back, where it still shows KilnWall's (if the user or
    // another app has set a picture since, that one stays), then forgets it, so the next first
    // change saves whatever is there then. A saved entry stays while its display is absent or its
    // file is gone. setDesktopImageURL reaches only the current Space.
    func restore(reason: String) {
        guard !testInstance else { return }
        let originals = OriginalDesktop.loadAll()
        guard !originals.isEmpty else { return }
        var left = originals
        for screen in NSScreen.screens {
            let display = Self.displayID(screen)
            let key = Self.key(display)
            guard let original = originals[key] else { continue }
            let current = NSWorkspace.shared.desktopImageURL(for: screen)
            if let current, !Self.isOurs(current) {
                log("desktop: display \(display) shows \(current.path), not KilnWall's; leaving it (\(reason))")
            } else if original.url.isFileURL, !FileManager.default.fileExists(atPath: original.url.path) {
                log("desktop: display \(display)'s original \(original.url.path) no longer exists; keeping it saved (\(reason))")
                continue
            } else {
                do {
                    try NSWorkspace.shared.setDesktopImageURL(original.url, for: screen, options: original.options)
                } catch {
                    log("desktop: display \(display): cannot restore \(original.url.path): \(error.localizedDescription)")
                    continue
                }
                // Not read back here: within this process desktopImageURL still returns the old URL
                // right after the set (another process reads the new one).
                log("desktop: restored display \(display) to \(original.url.absoluteString) \(Self.describe(original)) (\(reason))")
            }
            left[key] = nil
        }
        if left != originals {
            do {
                try OriginalDesktop.saveAll(left)
            } catch {
                log("desktop: cannot update \(Settings.file.path): \(error.localizedDescription)")
            }
        }
    }

    // MARK: Files

    private struct Problem: Error { let message: String }

    // Off the main thread. The snapshot is taken at the window's backing scale; if it is not
    // exactly width x height it is redrawn to that size. Opaque either way, as the window is: a
    // premultiplied snapshot is read as no-alpha (transparent pixels are black), with no copy.
    nonisolated private static func write(_ image: CGImage, width: Int, height: Int, to url: URL)
        -> Result<(Int, Bool), Problem> {
        var opaque = image.width == width && image.height == height ? asOpaque(image) : nil
        let redrawn = opaque == nil
        if opaque == nil {
            guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
            else { return .failure(Problem(message: "cannot make a \(width)x\(height) bitmap")) }
            context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            opaque = context.makeImage()
        }
        guard let opaque else { return .failure(Problem(message: "cannot write \(url.path)")) }
        return encode(opaque, to: url).map { ($0, redrawn) }
    }

    nonisolated private static func writeSolid(_ rgb: [CGFloat], to url: URL) -> Result<Int, Problem> {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: 64, height: 40, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return .failure(Problem(message: "cannot make a solid bitmap")) }
        context.setFillColor(CGColor(colorSpace: space, components: rgb + [1]) ?? CGColor(gray: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 40))
        guard let image = context.makeImage() else { return .failure(Problem(message: "cannot make a solid bitmap")) }
        return encode(image, to: url)
    }

    nonisolated private static func encode(_ image: CGImage, to url: URL) -> Result<Int, Problem> {
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            return .failure(Problem(message: "cannot create \(folder.path): \(error.localizedDescription)"))
        }
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { return .failure(Problem(message: "cannot write \(url.path)")) }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return .failure(Problem(message: "cannot write \(url.path)")) }
        return .success((try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0)
    }

    nonisolated private static func asOpaque(_ image: CGImage) -> CGImage? {
        let alpha: CGImageAlphaInfo
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast: return image
        case .premultipliedFirst: alpha = .noneSkipFirst
        case .premultipliedLast: alpha = .noneSkipLast
        default: return nil
        }
        guard let provider = image.dataProvider, let space = image.colorSpace else { return nil }
        let info = CGBitmapInfo(rawValue: image.bitmapInfo.rawValue & ~CGBitmapInfo.alphaInfoMask.rawValue | alpha.rawValue)
        return CGImage(width: image.width, height: image.height, bitsPerComponent: image.bitsPerComponent,
                       bitsPerPixel: image.bitsPerPixel, bytesPerRow: image.bytesPerRow, space: space,
                       bitmapInfo: info, provider: provider, decode: nil, shouldInterpolate: true,
                       intent: image.renderingIntent)
    }

    // The look a snapshot of a page told `told` shows: a forced light or dark is itself; "auto"
    // is read from the snapshot's luma mean (lightLumaMean). Nil: auto with no luma.
    nonisolated private static func shownLook(_ told: Look, _ stats: (mean: Double, std: Double)?) -> (Look, String)? {
        guard told.isAuto else { return (told, "\(told.appearance), as chosen") }
        guard let stats else { return nil }
        let light = stats.mean >= lightLumaMean
        return (Look(design: told.design, appearance: (light ? Appearance.light : .dark).rawValue),
                String(format: "auto drawn %@ (luma mean %.1f %@ %.0f)", light ? "light" : "dark", stats.mean, light ? ">=" : "<", lightLumaMean))
    }

    // Luma over a 48x30 grid: a populated page has a std of ~20 (glass), a blank one under 3.
    nonisolated static func lumaStats(_ image: CGImage) -> (mean: Double, std: Double)? {
        let width = 48, height = 30
        var pixels = [UInt8](repeating: 0, count: width * height)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
            else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        let count = Double(pixels.count)
        let mean = pixels.reduce(0.0) { $0 + Double($1) } / count
        let variance = pixels.reduce(0.0) { $0 + (Double($1) - mean) * (Double($1) - mean) } / count
        return (mean, variance.squareRoot())
    }

    // Kept: the newest `keep` files, the newest picture of each look, and the file last set
    // (`sparing`). Only this folder and only names this app writes are touched.
    nonisolated private static func prune(_ display: CGDirectDisplayID, sparing: String?) {
        let all = pictures(display)
        var kept = Set(all.suffix(keep).map(\.url.lastPathComponent))
        if let sparing { kept.insert(sparing) }
        var looks: Set<Look> = []
        for picture in all.reversed() where !picture.solid {
            if let look = picture.look, looks.insert(look).inserted { kept.insert(picture.url.lastPathComponent) }
        }
        for picture in all where !kept.contains(picture.url.lastPathComponent) {
            try? FileManager.default.removeItem(at: picture.url)
        }
    }

    // This display's newest picture of `look` (never a solid), if any: what main.swift lays over
    // a page that reloads or returns, and the desktop picture until a fresh one is taken.
    nonisolated static func newestPicture(_ display: CGDirectDisplayID, of look: Look) -> DesktopPicture? {
        pictures(display).last { !$0.solid && $0.look == look }
    }

    // This display's newest picture of `design` in either look (never a solid).
    nonisolated static func newestPicture(_ display: CGDirectDisplayID, design: String) -> DesktopPicture? {
        pictures(display).last { !$0.solid && $0.look?.design == design }
    }

    // The newest picture of each design (any appearance), for the menu's design pictures.
    nonisolated static func newestByDesign(_ display: CGDirectDisplayID) -> [String: DesktopPicture] {
        var newest: [String: DesktopPicture] = [:]
        for picture in pictures(display) where !picture.solid {
            if let design = picture.look?.design { newest[design] = picture }
        }
        return newest
    }

    // Oldest first.
    nonisolated private static func pictures(_ display: CGDirectDisplayID) -> [DesktopPicture] {
        ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [])
            .compactMap { DesktopPicture($0, display: display, in: folder) }
            .sorted { $0.ms != $1.ms ? $0.ms < $1.ms : $0.url.lastPathComponent < $1.url.lastPathComponent }
    }

    private static func isOurs(_ url: URL) -> Bool {
        url.isFileURL && canonicalPath(url.deletingLastPathComponent()) == canonicalPath(folder)
    }

    // MARK: Plumbing

    static func displayID(_ screen: NSScreen) -> CGDirectDisplayID {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    static func screen(_ display: CGDirectDisplayID) -> NSScreen? {
        NSScreen.screens.first { displayID($0) == display }
    }

    private static func key(_ display: CGDirectDisplayID) -> String {
        guard let uuid = CGDisplayCreateUUIDFromDisplayID(display)?.takeRetainedValue(),
              let text = CFUUIDCreateString(nil, uuid) as String?
        else { return "display-\(display)" }
        return text
    }

    private static func describe(_ original: OriginalDesktop) -> String {
        let fill = original.fillColor.map { $0.map { String(format: "%.3f", $0) }.joined(separator: ",") } ?? "-"
        return "(scaling \(original.scaling.map(String.init) ?? "-"), clipping \(original.allowClipping.map(String.init) ?? "-"), fill \(fill))"
    }

    nonisolated private static func ms(since start: UInt64) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
    }
}

// Each look's page background colour, learned from the page (main.swift's readBackground) and
// kept in backgrounds.json: what the window and a solid picture show for a look that has no
// picture yet, instead of another design.
@MainActor
enum DesignBackgrounds {
    private static let file = KilnSupport.folder.appendingPathComponent("backgrounds.json")
    private static var known: [String: String] = {
        guard let data = try? Data(contentsOf: file),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] else { return [:] }
        return object
    }()

    private static func key(_ look: Look) -> String { "\(look.design)@\(look.appearance)" }

    // The look's own colour; else the average of the design's picture in the menu's grid (all
    // designs shown before have one, so a fresh install's first switch is not a neutral); else
    // the design's colour in another appearance; else a neutral for it.
    static func colour(for look: Look) -> (colour: NSColor, source: String) {
        if let css = known[key(look)], let colour = KilnWall.opaqueColour(css) { return (colour, "its page's \(css)") }
        if let colour = average(DesignPictures.url(look.design)) { return (colour, "its grid picture's average") }
        if let (other, css) = known.first(where: { $0.key.hasPrefix(look.design + "@") }), let colour = KilnWall.opaqueColour(css) {
            return (colour, "\(other)'s \(css)")
        }
        let light = look.appearance == Appearance.light.rawValue
        return (NSColor(white: light ? 0.95 : 0.11, alpha: 1), "neutral \(light ? "light" : "dark")")
    }

    private static func average(_ url: URL) -> NSColor? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let small = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 32,
              ] as CFDictionary),
              let space = CGColorSpace(name: CGColorSpace.sRGB)
        else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        let drawn = pixel.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                          space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            context.interpolationQuality = .medium
            context.draw(small, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            return true
        }
        guard drawn else { return nil }
        return NSColor(srgbRed: Double(pixel[0]) / 255, green: Double(pixel[1]) / 255, blue: Double(pixel[2]) / 255, alpha: 1)
    }

    static func learn(_ css: String, for look: Look) {
        guard known[key(look)] != css else { return }
        known[key(look)] = css
        guard let data = try? JSONSerialization.data(withJSONObject: known, options: [.sortedKeys]) else { return }
        try? FileManager.default.createDirectory(at: KilnSupport.folder, withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }
}

// NSWorkspace's desktop image options <-> the plain values settings.json holds.
extension OriginalDesktop {
    init(display: String, url: URL, options: [NSWorkspace.DesktopImageOptionKey: Any]) {
        let fill = (options[.fillColor] as? NSColor)?.usingColorSpace(.genericRGB)
        self.init(
            display: display, url: url,
            scaling: (options[.imageScaling] as? NSNumber)?.intValue,
            allowClipping: (options[.allowClipping] as? NSNumber)?.boolValue,
            fillColor: fill.map { [$0.redComponent, $0.greenComponent, $0.blueComponent, $0.alphaComponent].map(Double.init) })
    }

    var options: [NSWorkspace.DesktopImageOptionKey: Any] {
        var options: [NSWorkspace.DesktopImageOptionKey: Any] = [:]
        if let scaling { options[.imageScaling] = scaling }
        if let allowClipping { options[.allowClipping] = allowClipping }
        if let fillColor, fillColor.count == 4 {
            options[.fillColor] = NSColor(calibratedRed: fillColor[0], green: fillColor[1], blue: fillColor[2], alpha: fillColor[3])
        }
        return options
    }
}
