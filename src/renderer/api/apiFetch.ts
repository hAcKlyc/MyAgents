/**
 * Unified API fetch utility that works in both browser and Tauri modes.
 * - Browser mode: Uses native fetch with relative URLs (Vite proxy)
 * - Tauri mode: Uses proxyFetch with full URLs through Rust proxy
 * 
 * For Tauri mode, this now uses the global Sidecar URL, which is suitable
 * for global operations like API key verification in Settings.
 */

import { getGlobalServerUrlWithWait, proxyFetch } from './tauriClient';
import { isTauriEnvironment } from '@/utils/browserMock';

/**
 * Fetch from API endpoint, handling both browser and Tauri modes
 * Uses the global Sidecar for API calls (suitable for Settings page)
 * Will wait for global sidecar to be ready before making requests
 * @param endpoint - API endpoint starting with / (e.g., '/agent/dir')
 * @param options - Fetch options
 */
export async function apiFetch(endpoint: string, options?: RequestInit): Promise<Response> {
    if (isTauriEnvironment()) {
        // Tauri mode: use global Sidecar URL (waits for sidecar to be ready)
        const baseUrl = await getGlobalServerUrlWithWait();
        const url = `${baseUrl}${endpoint}`;
        return proxyFetch(url, options);
    } else {
        // Browser mode: use relative URL (Vite proxy handles it)
        return fetch(endpoint, options);
    }
}

/**
 * POST JSON to API endpoint
 */
export async function apiPostJson<T>(endpoint: string, data: unknown): Promise<T> {
    const response = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error((errorData as { error?: string }).error || `HTTP ${response.status}`);
    }

    return response.json();
}

/**
 * GET JSON from API endpoint
 */
export async function apiGetJson<T>(endpoint: string): Promise<T> {
    const response = await apiFetch(endpoint);

    if (!response.ok) {
        const responseText = await response.text();
        console.error('[apiGetJson] Error response:', {
            status: response.status,
            endpoint,
            body: responseText.slice(0, 500) // First 500 chars
        });
        try {
            const errorData = JSON.parse(responseText);
            throw new Error((errorData as { error?: string }).error || `HTTP ${response.status}`);
        } catch {
            throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 100)}`);
        }
    }

    return response.json();
}

/**
 * POST FormData to API endpoint (for file uploads)
 * 
 * WARNING: FormData uploads don't work in Tauri mode through proxyFetch.
 * This function only works in browser development mode.
 * For Tauri mode file uploads, use Tauri's native file dialog APIs.
 */
export async function apiPostFormData<T>(endpoint: string, formData: FormData): Promise<T> {
    if (isTauriEnvironment()) {
        // FormData doesn't serialize properly through Tauri's proxyFetch
        // Need to use Tauri's native file APIs for file uploads in desktop mode
        throw new Error(
            'FormData uploads are not supported in desktop mode. ' +
            'Please use Tauri file dialog APIs for file operations.'
        );
    }

    // Browser mode: use native fetch
    const response = await fetch(endpoint, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error((errorData as { error?: string }).error || `HTTP ${response.status}`);
    }

    return response.json();
}

/**
 * PUT JSON to API endpoint
 */
export async function apiPutJson<T>(endpoint: string, data: unknown): Promise<T> {
    const response = await apiFetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error((errorData as { error?: string }).error || `HTTP ${response.status}`);
    }

    return response.json();
}

/**
 * DELETE request to API endpoint
 */
export async function apiDelete<T>(endpoint: string): Promise<T> {
    const response = await apiFetch(endpoint, {
        method: 'DELETE',
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error((errorData as { error?: string }).error || `HTTP ${response.status}`);
    }

    return response.json();
}
