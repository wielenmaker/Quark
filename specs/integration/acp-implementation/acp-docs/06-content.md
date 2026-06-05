# Content Blocks — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/content
> Cached: 2026-05-17

Content blocks represent displayable information. Compatible with MCP's ContentBlock structure.

## Content Types

### Text (baseline, MUST support)
```json
{ "type": "text", "text": "What's the weather?" }
```
- `text` (string, required)
- `annotations` (Annotations, optional)

### Image (requires `image` prompt capability)
```json
{ "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo..." }
```
- `data` (string, required) — base64 encoded
- `mimeType` (string, required)
- `uri` (string, optional)

### Audio (requires `audio` prompt capability)
```json
{ "type": "audio", "mimeType": "audio/wav", "data": "UklGRiQ..." }
```
- `data` (string, required) — base64 encoded
- `mimeType` (string, required)

### Embedded Resource (requires `embeddedContext` prompt capability)
```json
{
  "type": "resource",
  "resource": {
    "uri": "file:///home/user/script.py",
    "mimeType": "text/x-python",
    "text": "def hello(): ..."
  }
}
```
Preferred way to include context (avoids extra round-trips). Can be Text (with `text` field) or Blob (with `blob` field).

### Resource Link (baseline, MUST support)
```json
{
  "type": "resource_link",
  "uri": "file:///home/user/document.pdf",
  "name": "document.pdf",
  "mimeType": "application/pdf",
  "size": 1024000
}
```
Reference that the Agent can access.
- `uri` (string, required)
- `name` (string, required)
- `mimeType`, `title`, `description`, `size` (optional)
