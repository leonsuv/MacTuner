import Foundation

/// Single-file `.mtproj` project bundle storing XDF, BIN, comparison BINs, notes, history,
/// snapshots, locks, safe ranges, and checksum profile together.
struct MacTunerProject: Codable {
    struct StoredCompare: Codable {
        var name: String
        var dataBase64: String
    }

    struct StoredSnapshot: Codable {
        var meta: BinSnapshotMeta
        var dataBase64: String
    }

    var formatVersion: Int = 1
    var savedAt: Date = Date()
    var xdfName: String?
    var xdfXML: String?
    var binName: String?
    var binBase64: String?
    var compareName: String?
    var compareBase64: String?
    var extraCompares: [StoredCompare] = []
    var mapNotes: MapNotesStore.Payload = MapNotesStore.Payload()
    var history: [EditHistoryEntry] = []
    var snapshots: [StoredSnapshot] = []
    var favorites: [String] = []
    var lockedItems: [String] = []
    var safeRanges: [String: SafeRange] = [:]
    var checksumPluginID: String?

    static func save(_ project: MacTunerProject, to url: URL) throws {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        let data = try enc.encode(project)
        try data.write(to: url, options: .atomic)
    }

    static func load(from url: URL) throws -> MacTunerProject {
        let data = try Data(contentsOf: url)
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return try dec.decode(MacTunerProject.self, from: data)
    }
}
