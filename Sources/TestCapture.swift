// Test instance only (KILNWALL_TEST_HOME), with KILNWALL_TEST_CAPTURE=<folder>: what the window
// server composites for this app's OWN window, read by its window id (CGWindowListCreateImage
// with kCGWindowListOptionIncludingWindow), as fast as it can on a background thread, so a frame
// in which the window shows its plain background instead of the page or its picture is caught.
// Never the screen and never another app's window. A test window is below the desktop and fully
// covered by it (the window server reports it occluded); with this set it is opaque (alpha 1)
// instead of transparent, because the window server applies the window's alpha to the capture.
//
// Each run logs one line: the frames, how often, and every frame that differs from the run's
// last (the settled page) by more than `differs` mean absolute luma over 48x30, or is a uniform
// field (std < DesktopMatcher.blankLumaStd), with the main thread's marks (uncover, overlay up,
// fade) on the same clock. The first such frames, and the run's first and last, are written as
// PNGs in the folder.
import AppKit
import ImageIO
import IOSurface
import QuartzCore
import UniformTypeIdentifiers

final class WindowCapture: @unchecked Sendable {
    static let folder: URL? = TestHome.url == nil ? nil
        : ProcessInfo.processInfo.environment["KILNWALL_TEST_CAPTURE"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }

    // Mean absolute luma difference from the settled frame that counts as a different picture:
    // a page and its own snapshot differ by 2-4; the window's plain background and glass/dark by ~25.
    static let differs = 8.0
    private static let width = 48, height = 30
    private static let pngLimit = 6
    private static let keepLimit = 12

    // CGWindowListCreateImage is obsoleted in the macOS 15 SDK for ScreenCaptureKit but still
    // works for an app's own windows; looked up at run time.
    private typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
    private static let create: CreateImage? = {
        guard let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW),
              let symbol = dlsym(handle, "CGWindowListCreateImage") else { return nil }
        return unsafeBitCast(symbol, to: CreateImage.self)
    }()

    private struct Frame {
        let t: Double
        let ms: Double  // capture time
        let grid: [UInt8]
        let mean: Double
        let std: Double
        let image: CGImage?
        let keep: Bool
        func withoutImage() -> Frame {
            Frame(t: t, ms: ms, grid: grid, mean: mean, std: std, image: nil, keep: false)
        }
    }

    private let windowID: UInt32
    private let display: UInt32
    private let lock = NSLock()
    private var generation = 0
    private var marks: [(t: Double, what: String)] = []
    private var retired: [Int: [(t: Double, what: String)]] = [:]
    private var origin = CACurrentMediaTime()
    private var count = 0

    init(windowID: Int, display: UInt32) {
        self.windowID = UInt32(windowID)
        self.display = display
    }

    // Marks on the current run's clock (ms since it started).
    func mark(_ what: String) {
        lock.lock()
        marks.append(((CACurrentMediaTime() - origin) * 1000, what))
        lock.unlock()
    }

    // Captures every `interval` (0: back to back) for `duration` (nil: until the next run starts
    // or stop()), then logs the run as `label`.
    func run(_ label: String, interval: TimeInterval, duration: TimeInterval?) {
        lock.lock()
        retired[generation] = marks
        generation += 1
        let mine = generation
        origin = CACurrentMediaTime()
        marks = []
        count += 1
        let index = count
        lock.unlock()
        let start = origin
        Thread.detachNewThread { [self] in
            var frames: [Frame] = []
            var kept = 0
            while true {
                lock.lock()
                let current = generation == mine
                lock.unlock()
                let now = CACurrentMediaTime()
                if !current || (duration.map { now - start >= $0 } ?? false) { break }
                let before = CACurrentMediaTime()
                // kCGWindowListOptionIncludingWindow; kCGWindowImageBoundsIgnoreFraming | NominalResolution.
                // Nil until the window server has the window's first frame (at launch).
                guard let image = Self.create?(.null, 8, windowID, 1 | 16)?.takeRetainedValue() else {
                    Thread.sleep(forTimeInterval: 0.005)
                    continue
                }
                let after = CACurrentMediaTime()
                let (grid, mean, std) = Self.grid(image)
                // The pixels are kept (~6 MB each) only of the first frame, the latest, and up to
                // keepLimit that are blank or changed from the frame before.
                let changed = frames.last.map { Self.mad(grid, $0.grid) > Self.differs } ?? true
                let keep = frames.isEmpty || ((changed || std < DesktopMatcher.blankLumaStd) && kept < Self.keepLimit)
                if keep, !frames.isEmpty { kept += 1 }
                if let previous = frames.last, previous.image != nil, !previous.keep {
                    frames[frames.count - 1] = previous.withoutImage()
                }
                frames.append(Frame(t: (before - start) * 1000, ms: (after - before) * 1000, grid: grid, mean: mean, std: std,
                                    image: image, keep: keep))
                if interval > 0 { Thread.sleep(forTimeInterval: interval) }
            }
            lock.lock()
            // A run ended by the next one: its marks were set aside by that run.
            let marks = generation == mine ? self.marks : retired.removeValue(forKey: mine) ?? []
            lock.unlock()
            summarise(label, index: index, frames: frames, marks: marks)
        }
    }

    func stop() {
        lock.lock()
        retired[generation] = marks
        generation += 1
        lock.unlock()
    }

    private func summarise(_ label: String, index: Int, frames: [Frame], marks: [(t: Double, what: String)]) {
        guard let last = frames.last, let first = frames.first else {
            return log("test: capture \(label) display \(display): no frames (window \(windowID))")
        }
        var odd: [String] = []
        var written = 0
        let base = String(format: "cap%03d-%@-display%u", index, label, display)
        func write(_ frame: Frame, _ name: String) {
            guard let folder = Self.folder, let image = frame.image else { return }
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent("\(base)-\(name).png")
            if let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) {
                CGImageDestinationAddImage(destination, image, nil)
                CGImageDestinationFinalize(destination)
            }
        }
        var differing = 0
        for frame in frames {
            let mad = Self.mad(frame.grid, last.grid)
            let blank = frame.std < DesktopMatcher.blankLumaStd
            guard mad > Self.differs || blank else { continue }
            differing += 1
            if odd.count < 6 { odd.append(String(format: "%.0f ms: luma %.1f std %.1f, %.1f from the last%@", frame.t, frame.mean, frame.std, mad, blank ? " BLANK" : "")) }
            if written < Self.pngLimit, frame.image != nil {
                write(frame, String(format: "odd-%05.0fms", frame.t))
                written += 1
            }
        }
        write(first, "first")
        write(last, "last")
        let span = last.t - first.t
        let every = frames.count > 1 ? span / Double(frames.count - 1) : 0
        let blanks = frames.filter { $0.std < DesktopMatcher.blankLumaStd }
        let blankText = blanks.isEmpty ? "BLANK 0" : String(format: "BLANK %d (%.0f-%.0f ms)", blanks.count, blanks.first!.t, blanks.last!.t)
        let markText = marks.map { String(format: "%.0f ms %@", $0.t, $0.what) }.joined(separator: "; ")
        log(String(format: "test: capture %@ display %u: %d frames over %.0f ms (every %.1f ms, capture %.1f ms); first luma %.1f std %.1f, last %.1f std %.1f; %@; DIFFERING %d%@; marks: %@",
                   label, display, frames.count, span, every, frames.map(\.ms).reduce(0, +) / Double(frames.count),
                   first.mean, first.std, last.mean, last.std, blankText, differing,
                   odd.isEmpty ? "" : " [" + odd.joined(separator: " | ") + "]", markText.isEmpty ? "none" : markText))
    }

    // KILNWALL_TEST_PURGE=<s>: what memory pressure does to a hidden page, this many seconds into
    // a forced cover. WebKit marks a hidden page's tile surfaces volatile, and the kernel empties
    // volatile surfaces when it needs the memory (measured by 8b5eb6d in 3 of 4 real covers).
    // This empties those of the web view's layers that are volatile now, as the kernel would, and
    // leaves the rest alone. Returns a description of what it found and did.
    static let purgeAfter: TimeInterval? = TestHome.url == nil ? nil
        : ProcessInfo.processInfo.environment["KILNWALL_TEST_PURGE"].flatMap(Double.init)

    private static let quartzCore = dlopen("/System/Library/Frameworks/QuartzCore.framework/QuartzCore", RTLD_NOW)
    private static let caIOSurfaceGetTypeID: (@convention(c) () -> CFTypeID)? =
        dlsym(quartzCore, "CAIOSurfaceGetTypeID").map { unsafeBitCast($0, to: (@convention(c) () -> CFTypeID).self) }
    private static let caIOSurfaceGetIOSurface: (@convention(c) (UnsafeMutableRawPointer) -> Unmanaged<IOSurfaceRef>?)? =
        dlsym(quartzCore, "CAIOSurfaceGetIOSurface").map {
            unsafeBitCast($0, to: (@convention(c) (UnsafeMutableRawPointer) -> Unmanaged<IOSurfaceRef>?).self)
        }

    static func purgeVolatile(_ root: CALayer) -> String {
        var layers = 0, kinds: [String: Int] = [:], states: [String: Int] = [:], emptied = 0
        func visit(_ layer: CALayer) {
            layers += 1
            if let contents = layer.contents {
                let object = contents as AnyObject
                // WebKit's tiles arrive in the UI process as CAIOSurface (QuartzCore's private
                // wrapper; CAIOSurfaceGetIOSurface returns the surface without retaining it).
                var surface: IOSurfaceRef?
                if CFGetTypeID(object as CFTypeRef) == IOSurfaceGetTypeID() {
                    surface = unsafeBitCast(object, to: IOSurfaceRef.self)
                } else if let getTypeID = caIOSurfaceGetTypeID, let get = caIOSurfaceGetIOSurface,
                          CFGetTypeID(object as CFTypeRef) == getTypeID() {
                    surface = get(Unmanaged.passUnretained(object).toOpaque())?.takeUnretainedValue()
                }
                if let surface {
                    var old: UInt32 = 0
                    // kIOSurfacePurgeable NonVolatile 0, Volatile 1, Empty 2, KeepCurrent 3 (IOSurfaceTypes.h).
                    IOSurfaceSetPurgeable(surface, 3, &old)
                    let name = [0: "non-volatile", 1: "volatile", 2: "empty"][Int(old)] ?? "state \(old)"
                    states[name, default: 0] += 1
                    if old == 1 {
                        IOSurfaceSetPurgeable(surface, 2, &old)
                        emptied += 1
                    }
                    kinds["IOSurface", default: 0] += 1
                } else {
                    let kind = CFCopyTypeIDDescription(CFGetTypeID(object as CFTypeRef)) as String? ?? String(describing: type(of: object))
                    kinds[kind, default: 0] += 1
                }
            }
            for sublayer in layer.sublayers ?? [] { visit(sublayer) }
        }
        visit(root)
        func text(_ counts: [String: Int]) -> String {
            counts.isEmpty ? "none" : counts.keys.sorted().map { "\(counts[$0]!) \($0)" }.joined(separator: ", ")
        }
        return "\(layers) layers, contents: \(text(kinds)); surfaces were \(text(states)); emptied \(emptied)"
    }

    private static func grid(_ image: CGImage) -> ([UInt8], Double, Double) {
        var pixels = [UInt8](repeating: 0, count: width * height)
        pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                                          bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        let count = Double(pixels.count)
        let mean = pixels.reduce(0.0) { $0 + Double($1) } / count
        let variance = pixels.reduce(0.0) { $0 + (Double($1) - mean) * (Double($1) - mean) } / count
        return (pixels, mean, variance.squareRoot())
    }

    private static func mad(_ a: [UInt8], _ b: [UInt8]) -> Double {
        zip(a, b).reduce(0.0) { $0 + abs(Double($1.0) - Double($1.1)) } / Double(a.count)
    }
}

