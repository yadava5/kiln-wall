// Keeps the macOS desktop picture matched to the live wallpaper.
//
// Mission Control, Space switches and the Dock animate the system's desktop picture, not the
// wallpaper window, so whatever picture macOS holds flashes on screen in those transitions
// (recorded 2026-11-05: ~0.4 s entering Mission Control, ~1 frame leaving it). So each display's
// web view is snapshotted now and then and the snapshot set as that display's desktop picture.
// When (main.swift decides): 8 s after a page load (which covers a design change), when the
// wallpaper becomes paused (nobody sees it then; at most once per 120 s), on a Space change
// (the desktop picture is per Space and setDesktopImageURL sets only the current one), and when
// matching is switched on. Never on a timer while the wallpaper is visible.
//
// Each snapshot goes to a new file in ~/Library/Application Support/KilnWall/desktop/ (macOS
// caches the picture by URL, so a rewritten file would not be re-read), keeping the last two per
// display. JPEG at quality 0.9: measured 2026-11-05 on a 3024x1964 ledger snapshot, median of 7,
// JPEG 28.7 ms (1.9 MB), PNG 66.5 ms (1.2 MB), HEIC 0.9 68.1 ms (1.2 MB).
//
// The user's own picture is saved per display (OriginalDesktop, settings.json) before the first
// change and put back on Quit and when matching is switched off.
import AppKit
import ImageIO
import UniformTypeIdentifiers
import WebKit

@MainActor
final class DesktopMatcher {
    nonisolated static let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("KilnWall/desktop", isDirectory: true)
    nonisolated private static let keep = 2
    nonisolated private static let quality = 0.9
    private static let snapshotTimeout: TimeInterval = 10

    var enabled: Bool
    private let encoder = DispatchQueue(label: "io.github.yadava5.kilnwall.desktop", qos: .utility)
    // One update in flight per display; a request meanwhile is held (the latest reason) and run after.
    private var inFlight: [CGDirectDisplayID: Int] = [:]
    private var pending: [CGDirectDisplayID: String] = [:]
    private var serial = 0
    private let webViewFor: (CGDirectDisplayID) -> WKWebView?

    init(enabled: Bool, webViewFor: @escaping (CGDirectDisplayID) -> WKWebView?) {
        self.enabled = enabled
        self.webViewFor = webViewFor
    }

    // MARK: Updating

    func update(_ display: CGDirectDisplayID, reason: String) {
        guard enabled, let webView = webViewFor(display), let screen = Self.screen(display) else { return }
        if inFlight[display] != nil {
            pending[display] = reason
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

        DispatchQueue.main.asyncAfter(deadline: .now() + Self.snapshotTimeout) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.inFlight[display] == token else { return }
                log("desktop: display \(display) snapshot did not complete within \(Int(Self.snapshotTimeout)) s (\(reason))")
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
                    log("desktop: display \(display) snapshot failed: \(error?.localizedDescription ?? "no image") (\(reason))")
                    return self.done(display)
                }
                log(String(format: "desktop: snapshot display %u (%@): %dx%d px in %.1f ms, WebContent CPU %@",
                           display, reason, cgImage.width, cgImage.height, snapshotMs,
                           webCPU.map { String(format: "%.1f ms", $0) } ?? "unknown"))
                let url = Self.folder.appendingPathComponent(
                    "desktop-\(display)-\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
                self.encoder.async {
                    let encodeStarted = DispatchTime.now().uptimeNanoseconds
                    let result = Self.write(cgImage, width: width, height: height, to: url)
                    let encodeMs = Self.ms(since: encodeStarted)
                    if case .success = result { Self.prune(display) }
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            guard self.inFlight[display] == token else { return }
                            switch result {
                            case .success(let (bytes, redrawn)):
                                self.set(display, url, bytes: bytes, redrawn: redrawn, encodeMs: encodeMs, reason: reason)
                            case .failure(let problem):
                                log("desktop: display \(display): \(problem.message)")
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
        if let reason = pending.removeValue(forKey: display) { update(display, reason: reason) }
    }

    private func set(_ display: CGDirectDisplayID, _ url: URL, bytes: Int, redrawn: Bool, encodeMs: Double, reason: String) {
        // Switched off (or the display went) while the snapshot was being written.
        guard enabled, let screen = Self.screen(display) else { return }
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
        log(String(format: "desktop: set display %u to %@, %d bytes; JPEG encode + write %.1f ms%@, set %.1f ms",
                   display, url.path, bytes, encodeMs, redrawn ? " (redrawn to fit)" : "", Self.ms(since: started)))
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
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            return .failure(Problem(message: "cannot create \(folder.path): \(error.localizedDescription)"))
        }
        guard let opaque,
              let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { return .failure(Problem(message: "cannot write \(url.path)")) }
        CGImageDestinationAddImage(destination, opaque, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return .failure(Problem(message: "cannot write \(url.path)")) }
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        return .success((bytes, redrawn))
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

    // The newest `keep` of this display's files stay (names sort by time); only this folder and
    // only names this app writes are touched.
    nonisolated private static func prune(_ display: CGDirectDisplayID) {
        let prefix = "desktop-\(display)-"
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [])
            .filter { $0.hasPrefix(prefix) && $0.hasSuffix(".jpg") }
            .sorted { $0.count != $1.count ? $0.count < $1.count : $0 < $1 }
        for name in names.dropLast(keep) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
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
