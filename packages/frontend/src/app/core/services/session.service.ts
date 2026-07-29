import { Injectable } from '@angular/core';
import { v4 as uuidv4 } from 'uuid';

const SESSION_ID_KEY = 'mcp-session-id';

/**
 * Manages the browser-local chat session identifier.
 *
 * Extracted from duplicated logic previously found in both AppComponent and
 * ChatComponent so there is a single implementation of the get-or-create and
 * clear behavior.
 */
@Injectable({
  providedIn: 'root'
})
export class SessionService {
  /**
   * Get the current session ID from storage, or create and persist a new one.
   */
  getOrCreateSessionId(): string {
    const stored = localStorage.getItem(SESSION_ID_KEY);
    if (stored) {
      return stored;
    }
    const newId = uuidv4();
    localStorage.setItem(SESSION_ID_KEY, newId);
    return newId;
  }

  /**
   * Remove the stored session ID (e.g. when the user starts a new session).
   */
  clearSessionId(): void {
    localStorage.removeItem(SESSION_ID_KEY);
  }
}
