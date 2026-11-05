// Global hotkeys through Carbon's RegisterEventHotKey: the system delivers the chord to this app
// whichever app is in front, and it needs no Accessibility permission (an event tap would).
import Carbon.HIToolbox

@MainActor
final class Hotkeys {
    private var handler: EventHandlerRef?
    private var refs: [EventHotKeyRef] = []
    private var actions: [UInt32: () -> Void] = [:]
    nonisolated private static let signature: OSType = 0x4B49_4C4E  // "KILN"

    // Returns the OSStatus of the registration (noErr = 0 on success).
    @discardableResult
    func register(keyCode: Int, modifiers: Int, _ action: @escaping () -> Void) -> OSStatus {
        if handler == nil {
            let status = installHandler()
            if status != noErr { return status }
        }
        let id = UInt32(actions.count + 1)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            UInt32(keyCode), UInt32(modifiers), EventHotKeyID(signature: Self.signature, id: id),
            GetApplicationEventTarget(), 0, &ref)
        if status == noErr, let ref {
            refs.append(ref)
            actions[id] = action
        }
        return status
    }

    private func installHandler() -> OSStatus {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        return InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, userData in
                guard let event, let userData else { return OSStatus(eventNotHandledErr) }
                var hotKey = EventHotKeyID()
                let status = GetEventParameter(
                    event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                    MemoryLayout<EventHotKeyID>.size, nil, &hotKey)
                guard status == noErr, hotKey.signature == Hotkeys.signature else { return OSStatus(eventNotHandledErr) }
                let me = Unmanaged<Hotkeys>.fromOpaque(userData).takeUnretainedValue()
                MainActor.assumeIsolated { me.actions[hotKey.id]?() }
                return noErr
            },
            1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    deinit {
        for ref in refs { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
    }
}
