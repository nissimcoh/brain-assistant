// Brain Helper: the small Mac app that holds macOS permissions for Calendar, Reminders, Contacts,
// the camera, and (through AppleScript) Notes and Messages. Brain (Node) can't get these permissions itself.
//
// One request per launch:  open -W -n -g -j -a "Brain Helper.app" --args --request <in.json> --response <out.json>
// Asking for the permissions (once, at the Mac):  --authorize --response <out.json>
//
// Built on the Mac by scripts/apple-setup.ts (swiftc, ad-hoc signed). No network, no files besides
// the request and response it is given (and, for the camera, the photo or the live-view folder it is given).

import AppKit
import AVFoundation
import Contacts
import CoreImage
import EventKit
import Foundation
import ImageIO

let israel = TimeZone(identifier: "Asia/Jerusalem") ?? TimeZone.current

var gregorian: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = israel
    return c
}

func isoOut(_ d: Date) -> String {
    let f = ISO8601DateFormatter()
    f.timeZone = israel
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: d)
}

func dayOut(_ d: Date) -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = israel
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: d)
}

/// "2026-11-24T10:00" or "2026-11-24", in Israel time.
func parseLocal(_ s: String) -> Date? {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = israel
    f.locale = Locale(identifier: "en_US_POSIX")
    for format in ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"] {
        f.dateFormat = format
        if let d = f.date(from: s) { return d }
    }
    return nil
}

/// A value written from a completion handler (another thread) and read after waiting for it.
final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

struct Failure: Error {
    let code: String
    let message: String
}

func ekStatus(_ type: EKEntityType) -> String {
    switch EKEventStore.authorizationStatus(for: type) {
    case .fullAccess: return "full"
    case .writeOnly: return "writeOnly"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func contactsStatus() -> String {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized: return "full"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func requestEventKit(_ store: EKEventStore, _ type: EKEntityType) -> Bool {
    let done = DispatchSemaphore(value: 0)
    let granted = Box(false)
    let handler: EKEventStoreRequestAccessCompletionHandler = { ok, _ in
        granted.value = ok
        done.signal()
    }
    if type == .event {
        store.requestFullAccessToEvents(completion: handler)
    } else {
        store.requestFullAccessToReminders(completion: handler)
    }
    done.wait()
    return granted.value
}

func requestContacts() -> Bool {
    let done = DispatchSemaphore(value: 0)
    let granted = Box(false)
    CNContactStore().requestAccess(for: .contacts) { ok, _ in
        granted.value = ok
        done.signal()
    }
    done.wait()
    return granted.value
}

/// AppleScript must run on the main thread.
func runAppleScript(_ source: String) throws -> String {
    let output = Box("")
    let failure = Box<Failure?>(nil)
    DispatchQueue.main.sync {
        var error: NSDictionary?
        guard let script = NSAppleScript(source: source) else {
            failure.value = Failure(code: "applescript", message: "script did not compile")
            return
        }
        let result = script.executeAndReturnError(&error)
        if let error = error {
            let number = (error[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? 0
            let message = (error[NSAppleScript.errorMessage] as? String) ?? "\(error)"
            // -1743: the user hasn't allowed Brain Helper to control that app (Privacy → Automation).
            failure.value = Failure(code: number == -1743 ? "automation-denied" : "applescript", message: "\(number): \(message)")
            return
        }
        output.value = result.stringValue ?? ""
    }
    if let f = failure.value { throw f }
    return output.value
}

func str(_ req: [String: Any], _ key: String) -> String {
    return (req[key] as? String) ?? ""
}

func needAccess(_ type: EKEntityType) throws {
    if ekStatus(type) != "full" {
        throw Failure(code: type == .event ? "no-calendar-access" : "no-reminders-access", message: ekStatus(type))
    }
}

// ------------------------------------------------------------------ operations

func calendars(_ store: EKEventStore) -> [[String: Any]] {
    let def = store.defaultCalendarForNewEvents?.calendarIdentifier
    return store.calendars(for: .event).map { c in
        [
            "id": c.calendarIdentifier,
            "title": c.title,
            "source": c.source?.title ?? "",
            "writable": c.allowsContentModifications,
            "default": c.calendarIdentifier == def,
        ]
    }
}

func events(_ req: [String: Any]) throws -> Any {
    try needAccess(.event)
    guard let from = parseLocal(str(req, "from")), let to = parseLocal(str(req, "to")) else {
        throw Failure(code: "bad-request", message: "from/to")
    }
    let store = EKEventStore()
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
    let found = store.events(matching: predicate).filter { $0.status != .canceled }
    let list: [[String: Any]] = found.map { e in
        let allDay = e.isAllDay
        return [
            "title": e.title ?? "",
            "start": allDay ? dayOut(e.startDate) : isoOut(e.startDate),
            "end": allDay ? dayOut(e.endDate) : isoOut(e.endDate),
            "allDay": allDay,
            "location": e.location ?? "",
            "calendar": e.calendar?.title ?? "",
        ]
    }
    return ["events": list, "calendars": calendars(store)]
}

func createEvent(_ req: [String: Any]) throws -> Any {
    try needAccess(.event)
    let store = EKEventStore()
    let event = EKEvent(eventStore: store)
    event.title = str(req, "title")
    if (req["allDay"] as? Bool) == true {
        guard let day = parseLocal(str(req, "date")) else { throw Failure(code: "bad-request", message: "date") }
        event.isAllDay = true
        event.startDate = day
        event.endDate = day
    } else {
        guard let start = parseLocal(str(req, "start")), let end = parseLocal(str(req, "end")) else {
            throw Failure(code: "bad-request", message: "start/end")
        }
        event.startDate = start
        event.endDate = end
    }
    let location = str(req, "location")
    if !location.isEmpty { event.location = location }
    let notes = str(req, "notes")
    if !notes.isEmpty { event.notes = notes }
    let calendarId = str(req, "calendar")
    if !calendarId.isEmpty, let c = store.calendar(withIdentifier: calendarId) {
        event.calendar = c
    } else if let c = store.defaultCalendarForNewEvents {
        event.calendar = c
    } else {
        throw Failure(code: "no-calendar", message: "no default calendar")
    }
    try store.save(event, span: .thisEvent, commit: true)
    return ["id": event.eventIdentifier ?? "", "calendar": event.calendar?.title ?? ""]
}

func reminderLists(_ store: EKEventStore) -> [[String: Any]] {
    let def = store.defaultCalendarForNewReminders()?.calendarIdentifier
    return store.calendars(for: .reminder).map { c in
        ["id": c.calendarIdentifier, "title": c.title, "default": c.calendarIdentifier == def]
    }
}

func reminders(_ req: [String: Any]) throws -> Any {
    try needAccess(.reminder)
    let store = EKEventStore()
    var lists: [EKCalendar]? = nil
    let listId = str(req, "list")
    if !listId.isEmpty, let c = store.calendar(withIdentifier: listId) { lists = [c] }
    let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)
    let done = DispatchSemaphore(value: 0)
    let found = Box<[EKReminder]>([])
    _ = store.fetchReminders(matching: predicate) { items in
        found.value = items ?? []
        done.signal()
    }
    done.wait()
    let list: [[String: Any]] = found.value.map { r in
        var due = ""
        if let comps = r.dueDateComponents, let date = gregorian.date(from: comps) {
            due = comps.hour == nil ? dayOut(date) : isoOut(date)
        }
        return [
            "id": r.calendarItemIdentifier,
            "title": r.title ?? "",
            "due": due,
            "list": r.calendar?.title ?? "",
            "notes": r.notes ?? "",
        ]
    }
    return ["reminders": list, "lists": reminderLists(store)]
}

func createReminder(_ req: [String: Any]) throws -> Any {
    try needAccess(.reminder)
    let store = EKEventStore()
    let reminder = EKReminder(eventStore: store)
    reminder.title = str(req, "title")
    let listId = str(req, "list")
    if !listId.isEmpty, let c = store.calendar(withIdentifier: listId) {
        reminder.calendar = c
    } else if let c = store.defaultCalendarForNewReminders() {
        reminder.calendar = c
    } else {
        throw Failure(code: "no-list", message: "no default reminders list")
    }
    let due = str(req, "due")
    if !due.isEmpty {
        guard let date = parseLocal(due) else { throw Failure(code: "bad-request", message: "due") }
        let withTime = due.contains("T")
        let units: Set<Calendar.Component> = withTime ? [.year, .month, .day, .hour, .minute] : [.year, .month, .day]
        var comps = gregorian.dateComponents(units, from: date)
        comps.timeZone = israel
        reminder.dueDateComponents = comps
        // An alarm makes the iPhone (and the Mac) ring at that time.
        if withTime { reminder.addAlarm(EKAlarm(absoluteDate: date)) }
    }
    let notes = str(req, "notes")
    if !notes.isEmpty { reminder.notes = notes }
    try store.save(reminder, commit: true)
    return ["id": reminder.calendarItemIdentifier, "list": reminder.calendar?.title ?? ""]
}

func completeReminder(_ req: [String: Any]) throws -> Any {
    try needAccess(.reminder)
    let store = EKEventStore()
    guard let reminder = store.calendarItem(withIdentifier: str(req, "id")) as? EKReminder else {
        throw Failure(code: "not-found", message: "reminder")
    }
    reminder.isCompleted = true
    try store.save(reminder, commit: true)
    return ["title": reminder.title ?? ""]
}

func contacts(_ req: [String: Any]) throws -> Any {
    if contactsStatus() != "full" { throw Failure(code: "no-contacts-access", message: contactsStatus()) }
    let store = CNContactStore()
    let keys: [CNKeyDescriptor] = [
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        CNContactNicknameKey as CNKeyDescriptor,
        CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor,
    ]
    let predicate = CNContact.predicateForContacts(matchingName: str(req, "name"))
    let found = try store.unifiedContacts(matching: predicate, keysToFetch: keys)
    let list: [[String: Any]] = found.prefix(10).map { c in
        let name = CNContactFormatter.string(from: c, style: .fullName) ?? ""
        return [
            "name": name.isEmpty ? c.organizationName : name,
            "nickname": c.nickname,
            "phones": c.phoneNumbers.map { p in
                ["label": CNLabeledValue<NSString>.localizedString(forLabel: p.label ?? ""), "number": p.value.stringValue]
            },
            "emails": c.emailAddresses.map { e in
                ["label": CNLabeledValue<NSString>.localizedString(forLabel: e.label ?? ""), "email": e.value as String]
            },
        ]
    }
    return ["contacts": list]
}

// ------------------------------------------------------------------ camera
// macOS turns on the green light next to the camera whenever it's in use. Nothing here can turn that off.

func cameraStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return "full"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func requestCamera() -> Bool {
    let done = DispatchSemaphore(value: 0)
    let granted = Box(false)
    AVCaptureDevice.requestAccess(for: .video) { ok in
        granted.value = ok
        done.signal()
    }
    done.wait()
    return granted.value
}

/// Frames from the built-in camera, as JPEG. The handler returns false to stop receiving them.
final class FrameGrabber: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "brain.camera")
    let context = CIContext()
    let quality: Double
    let maxWidth: Double
    let handler: Box<((Data) -> Bool)?>

    init(quality: Double, maxWidth: Double, handler: @escaping (Data) -> Bool) {
        self.quality = quality
        self.maxWidth = maxWidth
        self.handler = Box(handler)
        super.init()
    }

    func start() throws {
        if cameraStatus() != "full" {
            throw Failure(code: "camera-denied", message: "no camera permission")
        }
        // The Mac's own camera, not an iPhone nearby (Continuity Camera) that macOS may prefer.
        let builtIn = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .unspecified
        ).devices.first
        guard let device = builtIn ?? AVCaptureDevice.default(for: .video) else {
            throw Failure(code: "camera-unavailable", message: "no camera (is the lid closed?)")
        }
        let input: AVCaptureDeviceInput
        do { input = try AVCaptureDeviceInput(device: device) } catch {
            throw Failure(code: "camera-busy", message: "\(error.localizedDescription)")
        }
        session.beginConfiguration()
        session.sessionPreset = .high
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw Failure(code: "camera-busy", message: "camera in use")
        }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw Failure(code: "camera-busy", message: "no video output")
        }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
    }

    func stop() {
        handler.value = nil
        if session.isRunning { session.stopRunning() }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let take = handler.value, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        var image = CIImage(cvPixelBuffer: pixels)
        let scale = min(1.0, maxWidth / Double(image.extent.width))
        if scale < 1.0 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        let key = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let jpeg = context.jpegRepresentation(of: image, colorSpace: space, options: [key: quality])
        else { return }
        if !take(jpeg) { handler.value = nil }
    }
}

/// One photo. The first frames are dark while the camera adjusts, so it waits a moment.
func cameraPhoto(_ req: [String: Any]) throws -> Any {
    let path = str(req, "output")
    if path.isEmpty { throw Failure(code: "bad-request", message: "no output") }
    let done = DispatchSemaphore(value: 0)
    let photo = Box<Data?>(nil)
    let started = Date()
    let frames = Box(0)
    let grabber = FrameGrabber(quality: 0.85, maxWidth: 1600) { jpeg in
        frames.value += 1
        if frames.value < 25 && Date().timeIntervalSince(started) < 2.0 { return true }
        photo.value = jpeg
        done.signal()
        return false
    }
    try grabber.start()
    let waited = done.wait(timeout: .now() + 12)
    grabber.stop()
    guard waited == .success, let jpeg = photo.value else {
        throw Failure(code: "camera-unavailable", message: "no picture from the camera")
    }
    guard FileManager.default.createFile(atPath: path, contents: jpeg, attributes: [.posixPermissions: 0o600]) else {
        throw Failure(code: "error", message: "could not save the photo")
    }
    return ["bytes": jpeg.count]
}

/// Live view: the newest frame is kept as <dir>/frame.jpg until Brain writes <dir>/stop, stops touching
/// <dir>/alive (Brain is gone), or the time is up. Never longer than 10 minutes.
func cameraLive(_ req: [String: Any]) throws -> Any {
    let dir = str(req, "dir")
    if dir.isEmpty { throw Failure(code: "bad-request", message: "no dir") }
    let maxSeconds = min(600.0, max(5.0, (req["maxSeconds"] as? Double) ?? 300))
    let fps = min(10.0, max(1.0, (req["fps"] as? Double) ?? 5))
    let fm = FileManager.default
    let frame = (dir as NSString).appendingPathComponent("frame.jpg")
    let partial = (dir as NSString).appendingPathComponent("frame.part")
    let stopFile = (dir as NSString).appendingPathComponent("stop")
    let alive = (dir as NSString).appendingPathComponent("alive")
    let lastWrite = Box(Date.distantPast)
    let count = Box(0)
    let grabber = FrameGrabber(quality: 0.6, maxWidth: 960) { jpeg in
        if Date().timeIntervalSince(lastWrite.value) < 1.0 / fps { return true }
        lastWrite.value = Date()
        if fm.createFile(atPath: partial, contents: jpeg, attributes: [.posixPermissions: 0o600]) {
            _ = try? fm.removeItem(atPath: frame)
            _ = try? fm.moveItem(atPath: partial, toPath: frame)
            count.value += 1
        }
        return true
    }
    try grabber.start()
    let started = Date()
    while true {
        Thread.sleep(forTimeInterval: 0.25)
        if fm.fileExists(atPath: stopFile) { break }
        if Date().timeIntervalSince(started) > maxSeconds { break }
        let touched = (try? fm.attributesOfItem(atPath: alive)[.modificationDate] as? Date) ?? started
        if Date().timeIntervalSince(touched) > 8 { break }
    }
    grabber.stop()
    return ["frames": count.value, "seconds": Int(Date().timeIntervalSince(started))]
}

func status() -> Any {
    var out: [String: Any] = ["calendar": ekStatus(.event), "reminders": ekStatus(.reminder), "contacts": contactsStatus(), "camera": cameraStatus()]
    let store = EKEventStore()
    if ekStatus(.event) == "full" { out["calendars"] = calendars(store) }
    if ekStatus(.reminder) == "full" { out["lists"] = reminderLists(store) }
    return out
}

func authorize() -> Any {
    DispatchQueue.main.async { NSApp.activate(ignoringOtherApps: true) }
    let store = EKEventStore()
    if ekStatus(.event) == "notDetermined" { _ = requestEventKit(store, .event) }
    if ekStatus(.reminder) == "notDetermined" { _ = requestEventKit(store, .reminder) }
    if contactsStatus() == "notDetermined" { _ = requestContacts() }
    if cameraStatus() == "notDetermined" { _ = requestCamera() }
    // Notes and Messages are controlled through AppleScript: macOS asks once for each.
    var notes = "full"
    var messages = "full"
    do { _ = try runAppleScript("tell application \"Notes\" to count notes") } catch let f as Failure {
        notes = f.code == "automation-denied" ? "denied" : "error: \(f.message)"
    } catch { notes = "error" }
    do { _ = try runAppleScript("tell application \"Messages\" to count accounts") } catch let f as Failure {
        messages = f.code == "automation-denied" ? "denied" : "error: \(f.message)"
    } catch { messages = "error" }
    return [
        "calendar": ekStatus(.event), "reminders": ekStatus(.reminder), "contacts": contactsStatus(),
        "notes": notes, "messages": messages, "camera": cameraStatus(),
    ]
}

func handle(_ req: [String: Any]) throws -> Any {
    switch str(req, "op") {
    case "status": return status()
    case "events": return try events(req)
    case "calendars":
        try needAccess(.event)
        return ["calendars": calendars(EKEventStore())]
    case "createEvent": return try createEvent(req)
    case "reminders": return try reminders(req)
    case "createReminder": return try createReminder(req)
    case "completeReminder": return try completeReminder(req)
    case "contacts": return try contacts(req)
    case "applescript": return ["output": try runAppleScript(str(req, "source"))]
    case "cameraPhoto": return try cameraPhoto(req)
    case "cameraLive": return try cameraLive(req)
    default: throw Failure(code: "bad-request", message: "unknown op")
    }
}

// ------------------------------------------------------------------ main

func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func writeResponse(_ object: Any) {
    guard let path = argument("--response") else { return }
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{\"ok\":false,\"code\":\"encode\"}".utf8)
    FileManager.default.createFile(atPath: path, contents: data, attributes: [.posixPermissions: 0o600])
}

func work() -> Int32 {
    if CommandLine.arguments.contains("--authorize") {
        writeResponse(["ok": true, "result": authorize()])
        return 0
    }
    guard let path = argument("--request"),
          let data = FileManager.default.contents(atPath: path),
          let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else {
        writeResponse(["ok": false, "code": "bad-request", "message": "no request"])
        return 1
    }
    do {
        writeResponse(["ok": true, "result": try handle(req)])
    } catch let f as Failure {
        writeResponse(["ok": false, "code": f.code, "message": f.message])
    } catch {
        writeResponse(["ok": false, "code": "error", "message": "\(error)"])
    }
    return 0
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.global(qos: .userInitiated).async {
    let code = work()
    exit(code)
}
app.run()
