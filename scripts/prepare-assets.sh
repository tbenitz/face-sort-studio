#!/usr/bin/env bash
# Copies pinned third-party browser libraries and weights into the published site.
# No visitor photo or video is ever sent to these hosts.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p vendor models
curl -fSL --retry 4 --retry-delay 2 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js' -o vendor/face-api.min.js
curl -fSL --retry 4 --retry-delay 2 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js' -o vendor/jszip.min.js
base='https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights'
for filename in \
  tiny_face_detector_model-weights_manifest.json tiny_face_detector_model-shard1 \
  face_landmark_68_tiny_model-weights_manifest.json face_landmark_68_tiny_model-shard1 \
  face_recognition_model-weights_manifest.json face_recognition_model-shard1 face_recognition_model-shard2 \
  ssd_mobilenetv1_model-weights_manifest.json ssd_mobilenetv1_model-shard1 ssd_mobilenetv1_model-shard2; do
  curl -fSL --retry 4 --retry-delay 2 "$base/$filename" -o "models/$filename"
done
echo "All browser libraries and AI models copied into this site directory."
