// SQLite LIKE 通配符转义与路由参数严格校验工具

export function escapeLikeTerm(term: string): string {
  return String(term || '').replace(/[\\%_]/g, '\\$&');
}

export function parsePositiveIntId(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

export function parseStrictNumber(raw: unknown): number | null {
  if (raw === undefined || raw === null || typeof raw === 'boolean' || typeof raw === 'object') {
    return null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseQueryPositiveInt(raw: string | undefined): { present: boolean; value: number | null; valid: boolean } {
  if (raw === undefined || raw.trim() === '') {
    return { present: false, value: null, valid: true };
  }
  const value = parsePositiveIntId(raw);
  return { present: true, value, valid: value !== null };
}

export function parseQueryNumber(raw: string | undefined): { present: boolean; value: number | null; valid: boolean } {
  if (raw === undefined || raw.trim() === '') {
    return { present: false, value: null, valid: true };
  }
  const value = parseStrictNumber(raw);
  return { present: true, value, valid: value !== null };
}
