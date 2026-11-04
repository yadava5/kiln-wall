// The data feed: kiln-feed.py as a child process, one JSON object per stdout line, or a built-in
// stub while that script does not exist. Started and stopped by KilnWall as visibility changes.
import Foundation
import os

@MainActor
final class Feed {
    nonisolated static let defaultScript = "/Users/ayush/.config/kitty/kiln-feed.py"
    private static let python = "/usr/bin/python3"
    private static let retryInterval: TimeInterval = 30
    private static let maxBackoff: TimeInterval = 60
    // A child that ran this long before exiting is treated as healthy: the backoff starts over.
    private static let healthyRun: TimeInterval = 60

    var onJSON: (([String: Any]) -> Void)?

    // A parameter only so the child-process path can be exercised against a test script.
    private let script: String
    init(script: String = Feed.defaultScript) { self.script = script }

    private var wanted = false
    private var process: Process?
    private var startedAt = Date()
    // Bumped whenever the current child is abandoned, so its late lines and exit are ignored.
    private var generation = 0
    private var stubTimer: Timer?
    private var retryTimer: Timer?
    private var restartWork: DispatchWorkItem?
    private var backoff: TimeInterval = 1
    private var lines = 0

    var mode: String {
        if !wanted { return "Feed stopped" }
        if let process { return "Feed: kiln-feed.py (pid \(process.processIdentifier))" }
        if stubTimer != nil { return "Feed: built-in stub (kiln-feed.py missing)" }
        return "Feed: restarting kiln-feed.py"
    }

    func start() {
        guard !wanted else { return }
        wanted = true
        backoff = 1
        launch()
    }

    func stop() {
        guard wanted else { return }
        wanted = false
        restartWork?.cancel()
        restartWork = nil
        stopStub()
        if let process {
            generation += 1
            self.process = nil
            if process.isRunning { process.terminate() }
            log("feed: stopped kiln-feed.py (pid \(process.processIdentifier))")
        }
    }

    private func launch() {
        guard wanted, process == nil else { return }
        if FileManager.default.fileExists(atPath: script) {
            stopStub()
            spawn()
        } else {
            startStub()
        }
    }

    // MARK: Child process

    private func spawn() {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: Self.python)
        child.arguments = [script, "--stream", "--hz", "1"]
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONUNBUFFERED"] = "1"  // a pipe would otherwise hold lines in a 4 KB buffer
        child.environment = environment
        child.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        child.standardOutput = out
        child.standardError = err

        generation += 1
        let current = generation
        lines = 0
        let stdoutLines = LineReader { [weak self] line in
            let object = try? JSONSerialization.jsonObject(with: line)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.received(object, bytes: line.count, from: current) }
            }
        }
        let stderrLines = LineReader { line in
            let text = String(decoding: line.prefix(1000), as: UTF8.self)
            logger.notice("feed stderr: \(text, privacy: .public)")
        }
        out.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { stdoutLines.append(data) }
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { stderrLines.append(data) }
        }
        child.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            let signalled = finished.terminationReason == .uncaughtSignal
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.exited(status: status, signalled: signalled, from: current) }
            }
        }

        do {
            try child.run()
            process = child
            startedAt = Date()
            log("feed: started kiln-feed.py (pid \(child.processIdentifier))")
        } catch {
            log("feed: cannot start kiln-feed.py: \(error.localizedDescription)")
            scheduleRestart()
        }
    }

    private func received(_ object: Any?, bytes: Int, from source: Int) {
        guard source == generation, wanted else { return }
        guard let json = object as? [String: Any] else {
            log("feed: skipped a line that is not a JSON object (\(bytes) bytes)")
            return
        }
        lines += 1
        if lines == 1 || lines % 60 == 0 { log("feed: line \(lines) from kiln-feed.py, \(bytes) bytes") }
        onJSON?(json)
    }

    private func exited(status: Int32, signalled: Bool, from source: Int) {
        guard source == generation, wanted else { return }  // stopped on purpose, or superseded
        process = nil
        if Date().timeIntervalSince(startedAt) >= Self.healthyRun { backoff = 1 }
        log("feed: kiln-feed.py \(signalled ? "killed by signal" : "exited with status") \(status)")
        scheduleRestart()
    }

    private func scheduleRestart() {
        let delay = backoff
        backoff = min(backoff * 2, Self.maxBackoff)
        log("feed: restarting in \(Int(delay)) s")
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.restartWork = nil
                self?.launch()
            }
        }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: Stub

    private func startStub() {
        guard stubTimer == nil else { return }
        log("feed: \(script) not found; using the built-in stub, retrying every \(Int(Self.retryInterval)) s")
        emitStub()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.emitStub() }
        }
        timer.tolerance = 0.1
        RunLoop.main.add(timer, forMode: .common)
        stubTimer = timer
        let retry = Timer(timeInterval: Self.retryInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.retryReal() }
        }
        retry.tolerance = 2
        RunLoop.main.add(retry, forMode: .common)
        retryTimer = retry
    }

    private func stopStub() {
        stubTimer?.invalidate()
        stubTimer = nil
        retryTimer?.invalidate()
        retryTimer = nil
    }

    private func emitStub() {
        let now = (Date().timeIntervalSince1970 * 1000).rounded() / 1000
        onJSON?(["v": 1, "t": now, "stub": true])
    }

    private func retryReal() {
        guard wanted, FileManager.default.fileExists(atPath: script) else { return }
        log("feed: \(script) appeared; switching from the stub")
        stopStub()
        spawn()
    }
}

// Splits a byte stream into lines. Only ever called from one FileHandle's readability handler,
// which runs serially, so the buffer needs no lock.
final class LineReader: @unchecked Sendable {
    private static let maxLine = 4 << 20
    private var buffer = Data()
    private let onLine: (Data) -> Void

    init(_ onLine: @escaping (Data) -> Void) { self.onLine = onLine }

    func append(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            if !line.isEmpty { onLine(Data(line)) }
        }
        // A runaway line with no newline must not grow without bound.
        if buffer.count > Self.maxLine { buffer.removeAll() }
    }
}
