# Specification: Add Photo Upload to Lesson Notes

## Goal

Implement **Option 1: direct image upload into TBT Notes lesson bodies**.

The teacher should be able to add a photo of paper lesson notes or an occasional screenshot directly inside a lesson note. This is not a general media manager and not a Google Photos integration.

The first version should support only:

- JPG / JPEG
- PNG

No paste-from-clipboard support yet. However, structure the upload helper so a future paste feature can reuse it.

---

## Product behaviour

### Teacher experience

In the lesson editor toolbar, add a simple image/photo button.

Suggested label/title:

- visible icon: `🖼` or a small photo icon
- tooltip / aria-label: `Add photo`

When the teacher clicks the button:

1. Open a native file picker.
2. Accept only `.jpg`, `.jpeg`, `.png` files.
3. Upload the selected file to the server.
4. Insert the uploaded image into the current Quill editor position.
5. Autosave the lesson body as usual.
6. Show a clear uploading/saving state while the upload is running.
7. Show a friendly error if the upload fails.

The teacher does not need image galleries, image search, cropping, advanced alignment, captions, or drag/drop in this version.

### Student experience

Students should see uploaded images inside the read-only lesson content.

Students must not download Quill and must not see upload controls. The existing architecture already loads Quill only for teachers; preserve that behaviour.

### Printing

Uploaded images should print reasonably:

- no overflow outside the page
- max width 100%
- keep aspect ratio
- avoid huge cropped images

---

## Current implementation notes

Relevant files:

- `assets/js/tbt-notes.js`
- `assets/css/tbt-notes.css`
- `includes/class-tbt-notes-rest.php`
- `includes/class-tbt-notes-sanitizer.php`
- possibly tests under `tests/`

Current app characteristics:

- Lesson editing uses Quill in `assets/js/tbt-notes.js`.
- The toolbar is built manually by `buildToolbar()`.
- `initEditor()` creates the Quill instance and defines allowed formats.
- Lesson body autosave currently uses JSON through the `api()` helper.
- `api()` hardcodes `Content-Type: application/json`, so it must **not** be used directly for file uploads.
- Server-side sanitisation currently allows only the editor's text-oriented HTML and strips unsupported tags.
- `<img>` is currently not allowed by `TBT_Notes_Sanitizer::allowed_html()`.

---

## Backend requirements

### 1. Add a teacher-only REST upload route

Add a new REST endpoint under the existing TBT Notes namespace.

Recommended route:

```text
POST /lessons/{id}/image
```

Example registration:

```php
register_rest_route(
    $ns,
    '/lessons/(?P<id>\d+)/image',
    array(
        'methods'             => WP_REST_Server::CREATABLE,
        'callback'            => array( $this, 'upload_lesson_image' ),
        'permission_callback' => array( $this, 'require_manage' ),
    )
);
```

The route should:

- require the same teacher/admin permission as other lesson write operations
- verify that the lesson exists
- accept a multipart file upload field named `file`
- reject missing files
- reject upload errors
- reject non-JPG/PNG files
- reject files that fail WordPress MIME validation
- return a useful REST error message with appropriate HTTP status

### 2. Store uploaded files in WordPress uploads / Media Library

For V1, use normal WordPress upload handling. This is acceptable for the current privacy requirement: images are shown only inside notes UI, although direct file URLs may technically be accessible if shared.

Implementation options:

- Prefer using WordPress media functions so files appear in the Media Library.
- Use `wp_handle_upload()` plus `wp_insert_attachment()` and metadata generation.
- Include `require_once ABSPATH . 'wp-admin/includes/file.php';`
- Include `require_once ABSPATH . 'wp-admin/includes/media.php';`
- Include `require_once ABSPATH . 'wp-admin/includes/image.php';`

Recommended metadata:

- attachment title based on original filename or lesson id
- attachment post parent may be `0` because lessons are custom DB rows, not WP posts
- optional attachment meta linking to lesson id, for example `_tbt_notes_lesson_id`

### 3. File validation

Allow only:

```php
'image/jpeg'
'image/png'
```

Accept extensions:

```text
jpg, jpeg, png
```

Reject everything else, including:

- WebP
- GIF
- HEIC / HEIF
- SVG
- PDF

Add a size limit. Suggested V1 maximum:

```text
8 MB
```

Reason: lesson note photos and screenshots can be large enough from a phone, but this should still prevent accidental massive uploads.

Return errors like:

- `Please choose a JPG or PNG image.`
- `The image is too large. Please choose an image under 8 MB.`
- `Could not upload the image. Please try again.`

### 4. Response shape

Return:

```json
{
  "image": {
    "id": 123,
    "url": "https://example.com/wp-content/uploads/.../file.jpg",
    "alt": "",
    "width": 1600,
    "height": 1200
  }
}
```

`width` and `height` can come from `wp_get_attachment_metadata()` or `getimagesize()` if available. If not available, return `null` or omit them.

### 5. Sanitiser changes

Update `TBT_Notes_Sanitizer::allowed_html()` to allow safe images in lesson bodies.

Add an `img` allowlist like:

```php
'img' => array(
    'src'     => true,
    'alt'     => true,
    'title'   => true,
    'width'   => true,
    'height'  => true,
    'loading' => true,
    'class'   => true,
),
```

Then update `normalize()` so image classes are restricted just like other classes.

Allowed image class for V1:

```text
tbt-notes-image
```

Important: only keep approved classes. Do not allow arbitrary classes or inline styles.

### 6. Optional but recommended: restrict image src URLs

For V1, the strictest safe approach is to allow only image URLs from the site's own uploads directory.

In `normalize()`, after kses, inspect all `<img>` elements:

- if `src` is empty, remove the image
- if `src` does not belong to the current site's uploads base URL, remove the image or remove `src`
- force `loading="lazy"`
- keep only safe numeric width/height if present
- keep `alt` as plain text

This protects against random external images and tracking pixels.

If this is too much for this iteration, at minimum rely on `wp_kses` URL protocol filtering and insert only uploaded URLs from the trusted upload route. But the upload-directory check is preferred.

---

## Frontend requirements

### 1. Add image format support to Quill

In `initEditor()`, add `image` to the allowed formats array.

Current formats include text and highlight formats. Add:

```js
'image'
```

### 2. Add toolbar button

In `buildToolbar()`, add a new custom button. Do not use a default `ql-image` handler unless it is overridden, because the default Quill behaviour prompts for an image URL and can create external image embeds.

Recommended custom button:

```js
var imgBtn = el( 'button', 'tbt-image-trigger' );
imgBtn.type = 'button';
imgBtn.setAttribute( 'aria-label', t( 'addPhoto', 'Add photo' ) );
imgBtn.title = t( 'addPhoto', 'Add photo' );
imgBtn.textContent = '🖼';
```

Place it near the link button or after the link group.

### 3. Add hidden file input

In `initEditor()`, create a hidden file input:

```js
var imageInput = document.createElement( 'input' );
imageInput.type = 'file';
imageInput.accept = 'image/jpeg,image/png,.jpg,.jpeg,.png';
imageInput.hidden = true;
```

Append it to the editor wrapper or toolbar area.

Clicking the image button should trigger `imageInput.click()`.

After every upload attempt, reset:

```js
imageInput.value = '';
```

This allows selecting the same file again later.

### 4. Add upload helper separate from `api()`

Do not modify the existing JSON `api()` helper for file uploads.

Create a new helper, for example:

```js
function uploadLessonImage( lessonId, file ) {
    var form = new FormData();
    form.append( 'file', file );

    return fetch( cfg.restUrl + 'lessons/' + lessonId + '/image', {
        method: 'POST',
        headers: {
            'X-WP-Nonce': cfg.nonce,
        },
        credentials: 'same-origin',
        body: form,
    } ).then( ...same error handling pattern as api()... );
}
```

Do not set `Content-Type`; the browser must set the multipart boundary.

This helper should be reusable later by a paste-from-clipboard feature.

### 5. Client-side validation

Before uploading, check:

- file exists
- MIME type is `image/jpeg` or `image/png`
- extension is `.jpg`, `.jpeg`, or `.png` if type is missing/unreliable
- file size is under 8 MB

Client validation is for better UX only. Server validation remains authoritative.

### 6. Insert image into Quill

When upload succeeds:

1. Get current selection or fallback to end of document.
2. Insert image embed with uploaded URL.
3. Add a line break after it if needed.
4. Apply a safe class if possible.
5. Update `lesson.body` from `quill.getSemanticHTML()`.
6. Queue autosave with the new body.

Basic insert:

```js
var range = quill.getSelection( true );
var index = range ? range.index : quill.getLength();
quill.insertEmbed( index, 'image', data.image.url, 'user' );
quill.insertText( index + 1, '\n', 'user' );
quill.setSelection( index + 2, 0, 'silent' );
```

Adding a class to the inserted image may require querying the editor DOM after insertion. If Quill strips/does not preserve custom image classes, rely on CSS targeting `.tbt-notes-read img` and `.ql-editor img` instead. The sanitiser can allow `img` without requiring a class.

### 7. Upload state and errors

Keep the UI simple.

During upload:

- disable the image button
- change title or text to `Uploading…`
- optionally set the existing save indicator to `Uploading image…`

On failure:

- re-enable the button
- show `window.alert()` or an inline error near the editor footer

Given the current app already uses simple alerts in flows, `window.alert()` is acceptable for V1. A nicer inline error can come later.

### 8. Autosave interaction

Image insertion should trigger Quill's `text-change` event because it is inserted with source `user`. The existing text-change handler should then update `lesson.body` and queue autosave.

Still, after upload insertion, explicitly ensure the current body is saved if needed.

Avoid autosaving the lesson body before the image URL exists. Do not insert local blob URLs or base64 data URLs into the note.

---

## CSS requirements

Add styles for images in both editor and read-only view.

Recommended:

```css
.tbt-notes-read img,
.tbt-notes-editorwrap .ql-editor img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 12px 0;
    border-radius: 10px;
}
```

For screenshots / paper note photos, images should appear large enough to read but never overflow the note area.

Print CSS:

```css
@media print {
    .tbt-notes-read img,
    .tbt-notes-editorwrap .ql-editor img {
        max-width: 100%;
        height: auto;
        break-inside: avoid;
        page-break-inside: avoid;
    }
}
```

Do not force fixed heights.

---

## Security and privacy notes

V1 privacy acceptance:

- Images are inserted only in lesson notes and visible through the notes UI to the teacher and assigned student(s), following the existing lesson visibility rules.
- Uploaded files may still be technically reachable by direct URL if someone has the file URL, because this version uses normal WordPress uploads.
- Do not expose an image gallery or list of all uploaded images in the notes UI.
- Do not allow students to upload images.
- Do not allow arbitrary external image URLs through the toolbar.
- Do not store base64 images in lesson body HTML.

---

## Out of scope for this task

Do not implement:

- Google Photos integration
- paste-from-clipboard
- drag and drop upload
- image cropping
- image resizing handles
- captions
- private file proxying
- WebP / HEIC support
- bulk image upload
- OCR / AI reading handwritten notes
- student uploads

---

## Acceptance criteria

### Happy path

1. Teacher opens an existing lesson note.
2. Teacher clicks `Add photo`.
3. Teacher selects a JPG file.
4. Image uploads successfully.
5. Image appears inside the editor at the cursor position.
6. Lesson autosaves.
7. Teacher refreshes the page.
8. Image is still visible in the note.
9. Assigned student opens the note.
10. Student sees the image in read-only mode.
11. Printing the note keeps the image within page width.

Repeat the same happy path with PNG.

### Validation

- Uploading a PDF is rejected.
- Uploading a GIF is rejected.
- Uploading a WebP is rejected.
- Uploading an oversized JPG/PNG is rejected.
- Students cannot access the upload route.
- Logged-out users cannot access the upload route.
- A malicious body containing `<script>` is still stripped.
- A malicious body containing `<img onerror="...">` does not preserve the event handler.
- A manually inserted external image URL is removed or at least not created by the toolbar.

### Regression checks

- Existing lesson text editing still autosaves.
- Existing highlight colours still work.
- Existing AI Quick Note still works.
- Existing pronunciation and expression card views still work.
- Student view still does not load Quill.
- Existing notes without images render normally.

---

## Suggested implementation order

1. Add backend upload route and handler.
2. Add server-side image validation and upload storage.
3. Add `img` support to the body sanitiser.
4. Add CSS for note images.
5. Add Quill `image` format support.
6. Add toolbar button and hidden file input.
7. Add `uploadLessonImage()` helper using `FormData`.
8. Insert uploaded image into Quill.
9. Test autosave and reload.
10. Add/update tests for sanitiser and upload validation where practical.

---

## Implementation hint: future paste support

Keep this upload path reusable:

```js
uploadLessonImage( lesson.id, file ).then( insertUploadedImage );
```

Later, paste support should only need to detect an image file from `clipboardData.items`, then call the same helper. Do not bake file-picker-only assumptions into the upload helper.
