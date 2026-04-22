import axios from 'axios';

const instance = axios.create({
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Universal API call helper.
 * Returns { data, status, headers } on success.
 * Returns { error: true, status, data, message } on failure — never throws.
 */
export async function apiCall(url, options = {}, overrideConfig = {}) {
  try {
    const cfg = { url, ...options, ...overrideConfig };
    const response = await instance.request(cfg);
    return { data: response.data, status: response.status, headers: response.headers };
  } catch (error) {
    if (error.response) {
      return {
        error: true,
        status: error.response.status,
        data: error.response.data,
        message: error.response.statusText || 'API error',
        headers: error.response.headers,
      };
    }
    if (error.request) {
      return { error: true, status: null, data: null, message: 'No response from API (network issue or timeout)' };
    }
    return { error: true, status: null, data: null, message: error.message || 'Unknown error' };
  }
}

export { instance };
