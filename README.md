# FaceSort Studio

**A private, browser-based photo/video face organizer with a human review workflow.**

FaceSort scans files **locally in your browser**, extracts face descriptors, clusters visually similar faces into unnamed people, and gives you a human-in-the-loop interface to rename, merge, split, move, and recheck them. It does not discover real-world names or contact any face-search service.

![App](https://img.shields.io/badge/host-GitHub%20Pages-purple) ![No backend](https://img.shields.io/badge/server-none-teal)

## Capabilities

- Add photos, multiple media files, or an entire nested directory. Drag folders onto the drop zone on Chromium browsers.
- Analyze *all detected faces* in each photo, and configurable snapshots of videos (every 1, 2, 4, 8, 15, or 30 seconds; up to 1,500 frames per video).
- Build a gallery for each auto-created person, with face crops, origin filenames, timestamps, and detection scores.
- Assign your own names. Select individual face examples and move them to a new or existing person.
- Merge split groups, with a second-pass similarity review proposing **possible duplicate groups**.
- Review low-quality, borderline, or uncertain face assignments. Explicitly mark similar people as different so those specific pairs are not suggested again.
- Search galleries and file names, jump directly to an original photo or to the matching timestamp of a locally attached video.
- Cancel a long scan, retry a failed/paused source, remove media, and reattach files after a reload without rescanning completed files.
- Save all gallery thumbnails, embeddings, manual corrections, ignored duplicate pairs and project settings in browser IndexedDB.
- Export a full JSON backup (**including sensitive numerical face descriptors**), CSV face-to-file index, and ZIP of per-person JPG face crops; import JSON backups.
- Switch between fast Tiny Face Detector and slower SSD MobileNet detector. Adjustable automatic match strictness.

## Deploy on GitHub Pages

1. Create an empty public repo, for example `face-sort-studio`.
2. Upload the contents of this project **preserving the directory paths**, or push them using `git`.
3. Open **Settings → Pages → Build and deployment → Source → GitHub Actions**.
4. Open **Actions**, run **Publish FaceSort Studio** if needed, and wait for a successful deployment.
5. Visit `https://YOUR_USERNAME.github.io/face-sort-studio/`.

The deployment workflow automatically downloads pinned face-api.js/JSZip browser libraries and model weights to the published artifact. Your visitor's model downloads come from your own GitHub Pages origin, not a third-party inference API. The repository has no backend and does not accept uploads.

If you run this project without GitHub Actions, the app has an HTTPS jsDelivr fallback for its JavaScript libraries and models. For a fully self-hosted local dev server, first run `bash scripts/prepare-assets.sh` (requires `curl`), then `python3 -m http.server 8000` and browse `http://localhost:8000`.

## Matching and review behavior

This is **face similarity clustering**, not authoritative identity recognition. A 128-value model embedding is compared using Euclidean distance. An embedding close to an existing group's sampled prototypes is automatically assigned to that group only if its distance is below the selected threshold (default `0.50`). Otherwise a new group is created. The review pass independently compares group examples for possible accidental splits up to a distance of `0.60`. These thresholds are heuristics, **not percentages or calibrated confidence**. People who look alike may be confused, while appearance, lighting, head rotation and small faces can split the same person.

Changing the threshold affects **new detections**, not already classified faces; existing groups are always editable. Recheck recomputes review suggestions, not automatic restructuring. The review view labels borderline / low-resolution / low-detection-score results for manual correction. To prevent accidentally merging distinct people, the app deliberately avoids fully automatic cross-group merges.

## Privacy, storage, and limitations

- Media bytes remain in the browser and are **not uploaded**. During scanning, the browser decodes the selected local file and feeds temporary canvas frames to the face model.
- The app **does store biometric face descriptors and small face thumbnails locally** in IndexedDB; they persist in that browser profile. JSON and ZIP exports contain sensitive images and/or descriptors. Protect exported files accordingly and get permission before processing other people's images.
- Original photos/videos are **not** stored in IndexedDB to avoid filling storage with big video files. After a browser restart, re-add the same files or folder to reattach previews. A backup can restore the library but not the original media.
- Video scanning is sampled, not every frame. Short appearances between samples can be missed. Slow computers can take significant time to scan long videos.
- MP4 H.264 and WebM are typically supported; MOV, HEVC and MKV depend on installed browser codecs. Unsupported videos are reported rather than silently skipped.
- Older computers and browsers can run out of RAM with very large face libraries. Use smaller batches, export backups, and reduce the frame cap if needed.
- Low light, extreme angles, occluded faces, very small faces, and lookalikes can produce incorrect groups. Human review is essential.
- Site needs a one-time online load on a fresh browser. No backend is used for recognition. GitHub Pages publishes its source publicly; **never commit private photos or exported face data to the repository**.

## Underlying libraries

- [face-api.js](https://github.com/justadudewhohacks/face-api.js) v0.22.2, MIT, including its distributed trained models.
- [JSZip](https://github.com/Stuk/jszip) v3.10.1, MIT OR GPL-3.0-or-later (MIT option), used to export face galleries.

The app code is MIT-licensed; third-party files retain their original licenses.
