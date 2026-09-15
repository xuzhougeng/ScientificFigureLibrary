import AppKit
let output = CommandLine.arguments[1]
let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
NSColor(calibratedRed: 0.14, green: 0.42, blue: 0.30, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 220, yRadius: 220).fill()
let title = NSAttributedString(string: "SFL", attributes: [.font: NSFont.systemFont(ofSize: 330, weight: .semibold), .foregroundColor: NSColor.white])
let size = title.size()
title.draw(at: NSPoint(x: (1024 - size.width) / 2, y: (1024 - size.height) / 2))
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
