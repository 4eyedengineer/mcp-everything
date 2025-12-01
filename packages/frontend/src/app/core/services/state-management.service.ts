import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';

export interface AppState {
  user: {
    isAuthenticated: boolean;
    profile?: any;
    preferences: {
      theme: 'light' | 'dark' | 'auto';
      language: string;
      notifications: boolean;
    };
  };
  ui: {
    sidebarOpen: boolean;
    currentRoute: string;
    breadcrumbs: Array<{ label: string; url?: string }>;
  };
  servers: {
    list: any[];
    selected?: string;
    filters: {
      status?: string;
      sourceType?: string;
      tags?: string[];
    };
    sorting: {
      field: string;
      direction: 'asc' | 'desc';
    };
  };
  generation: {
    active: Map<string, any>;
    history: any[];
  };
}

@Injectable({
  providedIn: 'root'
})
export class StateManagementService {
  private initialState: AppState = {
    user: {
      isAuthenticated: false,
      preferences: {
        theme: 'light',
        language: 'en',
        notifications: true
      }
    },
    ui: {
      sidebarOpen: true,
      currentRoute: '/',
      breadcrumbs: []
    },
    servers: {
      list: [],
      filters: {},
      sorting: {
        field: 'updatedAt',
        direction: 'desc'
      }
    },
    generation: {
      active: new Map(),
      history: []
    }
  };

  private stateSubject = new BehaviorSubject<AppState>(this.initialState);
  public state$ = this.stateSubject.asObservable();

  constructor() {
    // Load state from localStorage if available
    this.loadFromStorage();
  }

  /**
   * Get current state snapshot
   */
  getState(): AppState {
    return this.stateSubject.value;
  }

  /**
   * Update state with partial updates
   */
  updateState(updates: Partial<AppState>): void {
    const currentState = this.getState();
    const newState = this.deepMerge(currentState, updates);
    this.stateSubject.next(newState);
    this.saveToStorage(newState);
  }

  /**
   * Select specific part of state
   */
  select<T>(selector: (state: AppState) => T): Observable<T> {
    return this.state$.pipe(
      map(selector),
      distinctUntilChanged()
    );
  }

  /**
   * User state selectors and actions
   */
  selectUser() {
    return this.select(state => state.user);
  }

  selectUserPreferences() {
    return this.select(state => state.user.preferences);
  }

  updateUserPreferences(preferences: Partial<AppState['user']['preferences']>): void {
    this.updateState({
      user: {
        ...this.getState().user,
        preferences: {
          ...this.getState().user.preferences,
          ...preferences
        }
      }
    });
  }

  setAuthenticated(isAuthenticated: boolean, profile?: any): void {
    this.updateState({
      user: {
        ...this.getState().user,
        isAuthenticated,
        profile
      }
    });
  }

  /**
   * UI state selectors and actions
   */
  selectUI() {
    return this.select(state => state.ui);
  }

  setSidebarOpen(open: boolean): void {
    this.updateState({
      ui: {
        ...this.getState().ui,
        sidebarOpen: open
      }
    });
  }

  setCurrentRoute(route: string): void {
    this.updateState({
      ui: {
        ...this.getState().ui,
        currentRoute: route
      }
    });
  }

  setBreadcrumbs(breadcrumbs: Array<{ label: string; url?: string }>): void {
    this.updateState({
      ui: {
        ...this.getState().ui,
        breadcrumbs
      }
    });
  }

  /**
   * Servers state selectors and actions
   */
  selectServers() {
    return this.select(state => state.servers);
  }

  selectServersList() {
    return this.select(state => state.servers.list);
  }

  selectSelectedServer() {
    return this.select(state => state.servers.selected);
  }

  setServersList(servers: any[]): void {
    this.updateState({
      servers: {
        ...this.getState().servers,
        list: servers
      }
    });
  }

  setSelectedServer(serverId?: string): void {
    this.updateState({
      servers: {
        ...this.getState().servers,
        selected: serverId
      }
    });
  }

  updateServersFilters(filters: Partial<AppState['servers']['filters']>): void {
    this.updateState({
      servers: {
        ...this.getState().servers,
        filters: {
          ...this.getState().servers.filters,
          ...filters
        }
      }
    });
  }

  updateServersSorting(sorting: Partial<AppState['servers']['sorting']>): void {
    this.updateState({
      servers: {
        ...this.getState().servers,
        sorting: {
          ...this.getState().servers.sorting,
          ...sorting
        }
      }
    });
  }

  /**
   * Generation state selectors and actions
   */
  selectGeneration() {
    return this.select(state => state.generation);
  }

  selectActiveGenerations() {
    return this.select(state => Array.from(state.generation.active.values()));
  }

  addActiveGeneration(id: string, generation: any): void {
    const currentState = this.getState();
    const newActive = new Map(currentState.generation.active);
    newActive.set(id, generation);

    this.updateState({
      generation: {
        ...currentState.generation,
        active: newActive
      }
    });
  }

  updateActiveGeneration(id: string, updates: any): void {
    const currentState = this.getState();
    const existing = currentState.generation.active.get(id);
    if (existing) {
      const newActive = new Map(currentState.generation.active);
      newActive.set(id, { ...existing, ...updates });

      this.updateState({
        generation: {
          ...currentState.generation,
          active: newActive
        }
      });
    }
  }

  removeActiveGeneration(id: string): void {
    const currentState = this.getState();
    const newActive = new Map(currentState.generation.active);
    newActive.delete(id);

    this.updateState({
      generation: {
        ...currentState.generation,
        active: newActive
      }
    });
  }

  addToGenerationHistory(generation: any): void {
    const currentState = this.getState();
    this.updateState({
      generation: {
        ...currentState.generation,
        history: [generation, ...currentState.generation.history]
      }
    });
  }

  /**
   * Reset state to initial values
   */
  reset(): void {
    this.stateSubject.next(this.initialState);
    this.clearStorage();
  }

  /**
   * Deep merge objects
   */
  private deepMerge(target: any, source: any): any {
    const result = { ...target };

    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }

    return result;
  }

  /**
   * Save state to localStorage
   */
  private saveToStorage(state: AppState): void {
    try {
      // Only save specific parts of state, not everything
      const stateToSave = {
        user: {
          preferences: state.user.preferences
        },
        ui: {
          sidebarOpen: state.ui.sidebarOpen
        },
        servers: {
          filters: state.servers.filters,
          sorting: state.servers.sorting
        }
      };

      localStorage.setItem('mcp-everything-state', JSON.stringify(stateToSave));
    } catch (error) {
      console.warn('Failed to save state to localStorage:', error);
    }
  }

  /**
   * Load state from localStorage
   */
  private loadFromStorage(): void {
    try {
      const saved = localStorage.getItem('mcp-everything-state');
      if (saved) {
        const parsedState = JSON.parse(saved);
        this.updateState(parsedState);
      }
    } catch (error) {
      console.warn('Failed to load state from localStorage:', error);
    }
  }

  /**
   * Clear localStorage
   */
  private clearStorage(): void {
    try {
      localStorage.removeItem('mcp-everything-state');
    } catch (error) {
      console.warn('Failed to clear localStorage:', error);
    }
  }
}