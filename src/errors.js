export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
// A business-rule refusal discovered while holding locks, before any write. It is recorded, not rolled back.
export class Refusal extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
