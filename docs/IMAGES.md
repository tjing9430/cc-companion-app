# Image Uploads

The web client optimizes large mobile photos before upload.

## Current Behavior

- Files up to 10 MB may be selected.
- Images smaller than 280 KB are uploaded unchanged.
- Larger non-GIF images are decoded in the browser and scaled so the longest edge is at most 1440 px.
- JPEG and PNG photos are written as JPEG at quality `0.8`; WebP stays WebP.
- GIF files are not recompressed so animation is preserved.
- The server stores output dimensions and optimization metadata with the attachment.
- Message images use lazy loading and asynchronous decoding.

This avoids uploading and immediately rendering full-resolution phone camera images in the chat list.

## Future Options

- Add thumbnail/original dual storage for zoomable galleries.
- Move compression thresholds into settings.
- Add Web Worker or native Android resize paths for very large media batches.
