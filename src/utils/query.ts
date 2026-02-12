const TRUTHY_QUERY_VALUES = new Set(['1', 'true', 'yes', 'y', 'on']);

export function getBooleanQueryParam(request: Request, keys: string[]): boolean {
    const url = new URL(request.url);

    for (const key of keys) {
        const raw = url.searchParams.get(key);
        if (raw === null) continue;
        return TRUTHY_QUERY_VALUES.has(raw.trim().toLowerCase());
    }

    return false;
}
