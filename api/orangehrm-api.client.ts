/**
 * api/orangehrm-api.client.ts
 *
 * REST API client for OrangeHRM
 * Handles authentication and common API operations.
 */

export interface ApiResponse<T = unknown> {
  status: number;
  statusText: string;
  data?: T;
  error?: string;
}

export interface AuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface UserLoginPayload {
  username: string;
  password: string;
}

export interface EmployeeResponse {
  data: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  }>;
}

export class OrangeHRMApiClient {
  private baseUrl: string;
  private accessToken: string | null = null;

  constructor(baseUrl = "https://opensource-demo.orangehrmlive.com/api/v1") {
    this.baseUrl = baseUrl;
  }

  /**
   * Authenticate and retrieve an access token.
   */
  async authenticate(
    username: string,
    password: string,
  ): Promise<ApiResponse<AuthToken>> {
    const url = `${this.baseUrl}/auth/login`;
    const payload: UserLoginPayload = { username, password };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as AuthToken & { error?: string };

      if (!response.ok) {
        return {
          status: response.status,
          statusText: response.statusText,
          error: data.error || "Authentication failed",
        };
      }

      this.accessToken = data.access_token;
      return {
        status: response.status,
        statusText: response.statusText,
        data,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return {
        status: 0,
        statusText: "NETWORK_ERROR",
        error: message,
      };
    }
  }

  /**
   * Get the current access token.
   */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * Set a custom access token (useful for testing with predefined tokens).
   */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  /**
   * Fetch employee list.
   */
  async getEmployees(limit = 50, offset = 0): Promise<ApiResponse<EmployeeResponse>> {
    if (!this.accessToken) {
      return {
        status: 401,
        statusText: "Unauthorized",
        error: "No access token. Call authenticate() first.",
      };
    }

    const url = `${this.baseUrl}/admin/employees?limit=${limit}&offset=${offset}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      });

      const data = (await response.json()) as EmployeeResponse & { error?: string };

      if (!response.ok) {
        return {
          status: response.status,
          statusText: response.statusText,
          error: data.error || "Failed to fetch employees",
        };
      }

      return {
        status: response.status,
        statusText: response.statusText,
        data,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return {
        status: 0,
        statusText: "NETWORK_ERROR",
        error: message,
      };
    }
  }

  /**
   * Get a single employee by ID.
   */
  async getEmployee(employeeId: string): Promise<ApiResponse> {
    if (!this.accessToken) {
      return {
        status: 401,
        statusText: "Unauthorized",
        error: "No access token. Call authenticate() first.",
      };
    }

    const url = `${this.baseUrl}/admin/employees/${employeeId}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          status: response.status,
          statusText: response.statusText,
          error: data.error || "Failed to fetch employee",
        };
      }

      return {
        status: response.status,
        statusText: response.statusText,
        data,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return {
        status: 0,
        statusText: "NETWORK_ERROR",
        error: message,
      };
    }
  }

  /**
   * Verify authentication token validity.
   */
  async verifyToken(): Promise<boolean> {
    if (!this.accessToken) return false;

    const url = `${this.baseUrl}/admin/employees`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
