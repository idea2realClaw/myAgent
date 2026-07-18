---
name: mac-camera
description: This skill should be used when the user wants to take a photo using the Mac's built-in webcam, open Photo Booth, or capture the camera preview area. Triggers include phrases like "拍照", "拍个照片", "mac摄像头", "打开摄像头", "take a photo", "use webcam", or requests to display a live camera image in the conversation.
---

# Mac Webcam Photo Taker

Use Mac's built-in webcam to take photos and display them directly in the conversation.

## Core Script

```bash
python3 ~/.workbuddy/skills/mac-camera/scripts/mac_camera.py [--output <path>] [--http-share]
```

## Workflow

1. **Open Photo Booth**: Kill existing instance, then launch fresh
2. **Get window geometry** via AppleScript (`System Events`)
3. **Screenshot** the Photo Booth window using `screencapture -R`
4. **Crop** the webcam preview area (remove title bar, filmstrip, controls) using PIL
5. **Share via HTTP** (optional `--http-share`) — starts `python3 -m http.server 3000` on `/tmp` if not running

## Delivering Photos to the User

**Use `preview_url` tool, NOT `deliver_attachments`** for displaying images:

```
preview_url(url="http://localhost:3000/mac_camera_photo.png")
```

Steps:
1. Run script with `--http-share` to get the URL
2. Parse the JSON output, extract `preview_url`
3. Call `preview_url(url)` with that URL

If `--http-share` was not used, first copy the photo to a shared directory and start HTTP server:
```bash
cp /tmp/mac_camera_photo.png /tmp/shared_photo.png
# ensure HTTP server running at port 3000 on /tmp
preview_url(url="http://localhost:3000/shared_photo.png")
```

## Notes

- Requires **Photo Booth** app to be available (built-in on macOS)
- Photo Booth must be in **foreground** for the screenshot to capture the camera feed
- If the camera preview is black, the app may need to be brought to front or the camera may be in use by another app
- The HTTP server on port 3000 serves files from `/tmp`; other agents should also have this running or copy files to their own shared directory
- PIL (Pillow) is optional — if not available, the raw window screenshot is returned

## Examples

```bash
# Take photo and print JSON result
python3 ~/.workbuddy/skills/mac-camera/scripts/mac_camera.py

# Save to specific path
python3 ~/.workbuddy/skills/mac-camera/scripts/mac_camera.py -o /tmp/my_photo.png

# Take photo and start HTTP server for sharing
python3 ~/.workbuddy/skills/mac-camera/scripts/mac_camera.py --http-share
```
