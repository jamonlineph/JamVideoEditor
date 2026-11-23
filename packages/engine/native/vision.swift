// openedits-vision: Apple Vision helper for OpenEdits. All boxes are normalized with a TOP-LEFT origin.
//
//   subjects  <file> --times t,...                      faces and people per frame
//   saliency  <file> --times t,...                      attention-based salient regions per frame
//   track     <file> --box x,y,w,h --times t,...        follow a box through frames (times ascending)
//   cutout    <file> --time t --out out.png [--kind person|subject] [--point x,y]
//   masks     <file> --times t,... --width w --height h [--kind person|subject]
//             raw 8-bit masks (w*h bytes per time) on stdout; JSON progress on stderr
import AVFoundation
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

struct Failure: Error { let message: String }

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("{\"error\":\(jsonString(message))}\n".data(using: .utf8)!)
  exit(1)
}

func jsonString(_ s: String) -> String {
  let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
  let str = String(data: data, encoding: .utf8)!
  return String(str.dropFirst().dropLast())
}

func emit(_ obj: Any) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func round4(_ v: CGFloat) -> Double { (Double(v) * 10000).rounded() / 10000 }

/// Vision boxes have a bottom-left origin; convert to top-left.
func box(_ r: CGRect) -> [String: Double] {
  ["x": round4(r.origin.x), "y": round4(1 - r.origin.y - r.height), "w": round4(r.width), "h": round4(r.height)]
}

// MARK: - arguments

var args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else { fail("usage: openedits-vision <subjects|saliency|track|cutout|masks> <file> [options]") }
let command = args.removeFirst()
let path = args.removeFirst()
var options: [String: String] = [:]
var i = 0
while i < args.count {
  if args[i].hasPrefix("--"), i + 1 < args.count { options[String(args[i].dropFirst(2))] = args[i + 1]; i += 2 } else { i += 1 }
}
func numbers(_ key: String) -> [Double] { (options[key] ?? "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) } }

let url = URL(fileURLWithPath: path)
guard FileManager.default.fileExists(atPath: path) else { fail("File not found: \(path)") }

// MARK: - frames

let imageExts: Set<String> = ["png", "jpg", "jpeg", "heic", "heif", "webp", "tif", "tiff", "bmp", "gif"]
let isImage = imageExts.contains(url.pathExtension.lowercased())
var stillImage: CGImage?
var generator: AVAssetImageGenerator?

if isImage {
  guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
        let img = CGImageSourceCreateThumbnailAtIndex(src, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 8192] as CFDictionary) else { fail("Could not read image \(path)") }
  stillImage = img
} else {
  let asset = AVURLAsset(url: url)
  let g = AVAssetImageGenerator(asset: asset)
  g.appliesPreferredTrackTransform = true
  g.requestedTimeToleranceBefore = .zero
  g.requestedTimeToleranceAfter = .zero
  generator = g
}

func frame(at t: Double) -> CGImage? {
  if let img = stillImage { return img }
  return try? generator!.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil)
}

// MARK: - commands

func subjects() {
  let times = numbers("times")
  var out: [[String: Any]] = []
  for t in times {
    guard let img = frame(at: t) else { out.append(["time": t, "error": "no frame"]); continue }
    let faces = VNDetectFaceRectanglesRequest()
    let humans = VNDetectHumanRectanglesRequest()
    humans.upperBodyOnly = false
    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    try? handler.perform([faces, humans])
    out.append([
      "time": t,
      "faces": (faces.results ?? []).map { ["box": box($0.boundingBox), "confidence": round4(CGFloat($0.confidence))] },
      "people": (humans.results ?? []).map { ["box": box($0.boundingBox), "confidence": round4(CGFloat($0.confidence))] },
    ])
  }
  emit(["frames": out, "width": stillImage?.width ?? 0])
}

func saliency() {
  var out: [[String: Any]] = []
  for t in numbers("times") {
    guard let img = frame(at: t) else { out.append(["time": t, "error": "no frame"]); continue }
    let req = VNGenerateAttentionBasedSaliencyImageRequest()
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    let objects = (req.results?.first?.salientObjects ?? []).map { ["box": box($0.boundingBox), "confidence": round4(CGFloat($0.confidence))] }
    out.append(["time": t, "objects": objects])
  }
  emit(["frames": out])
}

func track() {
  let b = numbers("box")
  guard b.count == 4 else { fail("--box x,y,w,h is required (normalized, top-left origin)") }
  let times = numbers("times")
  // Top-left -> Vision's bottom-left origin.
  var observation = VNDetectedObjectObservation(boundingBox: CGRect(x: b[0], y: 1 - b[1] - b[3], width: b[2], height: b[3]))
  let sequence = VNSequenceRequestHandler()
  var out: [[String: Any]] = []
  var lost = false
  for (k, t) in times.enumerated() {
    guard let img = frame(at: t) else { out.append(["time": t, "error": "no frame"]); continue }
    if lost { break }
    _ = k
    let req = VNTrackObjectRequest(detectedObjectObservation: observation)
    req.trackingLevel = .accurate
    do { try sequence.perform([req], on: img) } catch { out.append(["time": t, "error": "\(error)"]); lost = true; continue }
    guard let next = req.results?.first as? VNDetectedObjectObservation else { lost = true; continue }
    observation = next
    out.append(["time": t, "box": box(next.boundingBox), "confidence": round4(CGFloat(next.confidence))])
    if next.confidence < 0.3 { lost = true }
  }
  emit(["frames": out, "lost": lost])
}

@available(macOS 14.0, *)
func instanceRequest(_ kind: String) -> VNImageBasedRequest {
  kind == "person" ? VNGeneratePersonInstanceMaskRequest() : VNGenerateForegroundInstanceMaskRequest()
}

@available(macOS 14.0, *)
func instanceResult(_ req: VNImageBasedRequest) -> VNInstanceMaskObservation? {
  req.results?.first as? VNInstanceMaskObservation
}

/// Instances to keep: the one under `point` (top-left normalized), or all of them.
@available(macOS 14.0, *)
func pickInstances(_ obs: VNInstanceMaskObservation, point: [Double]) -> IndexSet {
  guard point.count == 2 else { return obs.allInstances }
  let mask = obs.instanceMask
  CVPixelBufferLockBaseAddress(mask, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
  let w = CVPixelBufferGetWidth(mask), h = CVPixelBufferGetHeight(mask)
  let x = min(w - 1, max(0, Int(point[0] * Double(w)))), y = min(h - 1, max(0, Int(point[1] * Double(h))))
  let row = CVPixelBufferGetBaseAddress(mask)!.advanced(by: y * CVPixelBufferGetBytesPerRow(mask)).assumingMemoryBound(to: UInt8.self)
  let id = Int(row[x])
  return id == 0 ? IndexSet() : IndexSet(integer: id)
}

@available(macOS 14.0, *)
func cutout() {
  guard let out = options["out"] else { fail("--out is required") }
  let t = numbers("time").first ?? 0
  let kind = options["kind"] ?? "subject"
  guard let img = frame(at: t) else { fail("No frame at \(t)s") }
  let req = instanceRequest(kind)
  let handler = VNImageRequestHandler(cgImage: img, options: [:])
  do { try handler.perform([req]) } catch { fail("Vision failed: \(error)") }
  guard let obs = instanceResult(req) else { fail(kind == "person" ? "No person found in the frame" : "No foreground subject found in the frame") }
  let instances = pickInstances(obs, point: numbers("point"))
  if instances.isEmpty { fail("No subject at that point") }
  let buffer: CVPixelBuffer
  do { buffer = try obs.generateMaskedImage(ofInstances: instances, from: handler, croppedToInstancesExtent: true) } catch { fail("Could not cut out the subject: \(error)") }
  // The extent of the instances in the full frame (for placing the sticker where the subject was).
  var extent = CGRect.null
  if let full = try? obs.generateScaledMaskForImage(forInstances: instances, from: handler) {
    CVPixelBufferLockBaseAddress(full, .readOnly)
    let w = CVPixelBufferGetWidth(full), h = CVPixelBufferGetHeight(full), rowStride = CVPixelBufferGetBytesPerRow(full)
    let base = CVPixelBufferGetBaseAddress(full)!
    var minX = w, minY = h, maxX = -1, maxY = -1
    for y in stride(from: 0, to: h, by: 2) {
      let row = base.advanced(by: y * rowStride).assumingMemoryBound(to: Float32.self)
      for x in stride(from: 0, to: w, by: 2) where row[x] > 0.5 {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
      }
    }
    CVPixelBufferUnlockBaseAddress(full, .readOnly)
    if maxX >= 0 { extent = CGRect(x: Double(minX) / Double(w), y: Double(minY) / Double(h), width: Double(maxX - minX + 2) / Double(w), height: Double(maxY - minY + 2) / Double(h)) }
  }
  let ci = CIImage(cvPixelBuffer: buffer)
  let ctx = CIContext()
  guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { fail("No sRGB color space") }
  do { try ctx.writePNGRepresentation(of: ci, to: URL(fileURLWithPath: out), format: .RGBA8, colorSpace: space) } catch { fail("Could not write \(out): \(error)") }
  var result: [String: Any] = ["path": out, "width": Int(ci.extent.width), "height": Int(ci.extent.height), "instances": instances.count, "time": t]
  if !extent.isNull { result["box"] = ["x": round4(extent.origin.x), "y": round4(extent.origin.y), "w": round4(extent.width), "h": round4(extent.height)] }
  emit(result)
}

func masks() {
  let times = numbers("times")
  guard let w = Int(options["width"] ?? ""), let h = Int(options["height"] ?? ""), w > 0, h > 0 else { fail("--width and --height are required") }
  let kind = options["kind"] ?? "person"
  if kind != "person" {
    guard #available(macOS 14.0, *) else { fail("Foreground subject masks require macOS 14 or later") }
  }
  let ctx = CIContext()
  let gray = CGColorSpaceCreateDeviceGray()
  var bytes = [UInt8](repeating: 0, count: w * h)
  let stdout = FileHandle.standardOutput
  for (k, t) in times.enumerated() {
    for idx in bytes.indices { bytes[idx] = 0 }
    if let img = frame(at: t) {
      let handler = VNImageRequestHandler(cgImage: img, options: [:])
      var mask: CIImage?
      if kind == "person" {
        let req = VNGeneratePersonSegmentationRequest()
        req.qualityLevel = .balanced
        req.outputPixelFormat = kCVPixelFormatType_OneComponent8
        try? handler.perform([req])
        if let buf = req.results?.first?.pixelBuffer { mask = CIImage(cvPixelBuffer: buf) }
      } else if #available(macOS 14.0, *) {
        let req = VNGenerateForegroundInstanceMaskRequest()
        try? handler.perform([req])
        if let obs = req.results?.first, let buf = try? obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler) { mask = CIImage(cvPixelBuffer: buf) }
      }
      if let m = mask {
        let scaled = m.transformed(by: CGAffineTransform(scaleX: CGFloat(w) / m.extent.width, y: CGFloat(h) / m.extent.height))
        bytes.withUnsafeMutableBytes { ptr in
          ctx.render(scaled, toBitmap: ptr.baseAddress!, rowBytes: w, bounds: CGRect(x: 0, y: 0, width: w, height: h), format: .L8, colorSpace: gray)
        }
      }
    }
    stdout.write(Data(bytes))
    FileHandle.standardError.write("{\"done\":\(k + 1),\"total\":\(times.count)}\n".data(using: .utf8)!)
  }
}

switch command {
case "subjects": subjects()
case "saliency": saliency()
case "track": track()
case "cutout":
  guard #available(macOS 14.0, *) else { fail("Instance cutouts require macOS 14 or later") }
  cutout()
case "masks": masks()
default: fail("Unknown command \(command)")
}
