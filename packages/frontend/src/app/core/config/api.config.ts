import { environment } from '../../../environments/environment';

/**
 * Single source of truth for backend API base paths.
 *
 * All services should derive their endpoint URLs from these constants instead
 * of hardcoding `http://localhost:3000` or duplicating `environment.apiUrl`
 * concatenation logic.
 */

/** Base path for the unversioned `/api` routes (e.g. `/api/chat`, `/api/conversations`). */
export const API_BASE = `${environment.apiUrl}/api`;

/** Base path for the versioned `/api/v1` routes (e.g. `/api/v1/auth`, `/api/v1/marketplace`). */
export const API_V1_BASE = `${environment.apiUrl}/api/v1`;
