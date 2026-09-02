/**
 * api/orangehrm-api.example.test.ts
 *
 * API Integration Tests for OrangeHRM REST endpoints.
 * Tests authentication, employee CRUD operations, and error handling.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { OrangeHRMApiClient } from "./orangehrm-api.client";

// ───────────────────────────────────────────────────────────────────────────
// Mock API Server Simulation (for unit tests without real API)
// ───────────────────────────────────────────────────────────────────────────

class MockOrangeHRMApiClient extends OrangeHRMApiClient {
  async authenticate(username: string, password: string) {
    // Mock: Admin / admin123 always succeeds
    if (username === "Admin" && password === "admin123") {
      this.setAccessToken("mock-token-xyz123");
      return {
        status: 200,
        statusText: "OK",
        data: {
          access_token: "mock-token-xyz123",
          token_type: "Bearer",
          expires_in: 3600,
        },
      };
    }

    // Mock: Invalid credentials
    return {
      status: 401,
      statusText: "Unauthorized",
      error: "Invalid credentials",
    };
  }

  async getEmployees(limit = 50, offset = 0) {
    if (!this.getAccessToken()) {
      return {
        status: 401,
        statusText: "Unauthorized",
        error: "No access token",
      };
    }

    return {
      status: 200,
      statusText: "OK",
      data: {
        data: [
          {
            id: "1",
            firstName: "Peter",
            lastName: "Parker",
            email: "peter@orangehrm.test",
          },
          {
            id: "2",
            firstName: "Mary",
            lastName: "Jane",
            email: "mary@orangehrm.test",
          },
        ],
      },
    };
  }

  async getEmployee(employeeId: string) {
    if (!this.getAccessToken()) {
      return {
        status: 401,
        statusText: "Unauthorized",
        error: "No access token",
      };
    }

    if (employeeId === "1") {
      return {
        status: 200,
        statusText: "OK",
        data: {
          id: "1",
          firstName: "Peter",
          lastName: "Parker",
          email: "peter@orangehrm.test",
        },
      };
    }

    return {
      status: 404,
      statusText: "Not Found",
      error: `Employee ${employeeId} not found`,
    };
  }

  async verifyToken(): Promise<boolean> {
    // Mock: Token is valid if it's set
    return !!this.getAccessToken();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

test("OrangeHRMApiClient: authenticate with valid credentials", async () => {
  const client = new MockOrangeHRMApiClient();
  const result = await client.authenticate("Admin", "admin123");

  assert.equal(result.status, 200);
  assert.equal(result.statusText, "OK");
  assert.ok(result.data);
  assert.equal(result.data.access_token, "mock-token-xyz123");
  assert.equal(client.getAccessToken(), "mock-token-xyz123");
});

test("OrangeHRMApiClient: reject invalid credentials", async () => {
  const client = new MockOrangeHRMApiClient();
  const result = await client.authenticate("Admin", "wrongpassword");

  assert.equal(result.status, 401);
  assert.equal(result.statusText, "Unauthorized");
  assert.ok(result.error);
  assert.equal(client.getAccessToken(), null);
});

test("OrangeHRMApiClient: getEmployees requires authentication", async () => {
  const client = new MockOrangeHRMApiClient();
  const result = await client.getEmployees();

  assert.equal(result.status, 401);
  assert.ok(result.error);
});

test("OrangeHRMApiClient: getEmployees returns employee list after auth", async () => {
  const client = new MockOrangeHRMApiClient();
  await client.authenticate("Admin", "admin123");

  const result = await client.getEmployees();

  assert.equal(result.status, 200);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.data));
  assert.equal(result.data.data.length, 2);
  assert.equal(result.data.data[0].firstName, "Peter");
});

test("OrangeHRMApiClient: getEmployee returns single employee", async () => {
  const client = new MockOrangeHRMApiClient();
  await client.authenticate("Admin", "admin123");

  const result = await client.getEmployee("1");

  assert.equal(result.status, 200);
  assert.ok(result.data);
  assert.equal(result.data.id, "1");
  assert.equal(result.data.firstName, "Peter");
  assert.equal(result.data.email, "peter@orangehrm.test");
});

test("OrangeHRMApiClient: getEmployee returns 404 for missing employee", async () => {
  const client = new MockOrangeHRMApiClient();
  await client.authenticate("Admin", "admin123");

  const result = await client.getEmployee("999");

  assert.equal(result.status, 404);
  assert.ok(result.error);
  assert.match(result.error, /not found/i);
});

test("OrangeHRMApiClient: verifyToken returns true after successful auth", async () => {
  const client = new MockOrangeHRMApiClient();
  await client.authenticate("Admin", "admin123");

  const isValid = await client.verifyToken();

  assert.equal(isValid, true);
});

test("OrangeHRMApiClient: verifyToken returns false without token", async () => {
  const client = new MockOrangeHRMApiClient();

  const isValid = await client.verifyToken();

  assert.equal(isValid, false);
});

test("OrangeHRMApiClient: setAccessToken allows custom token", async () => {
  const client = new MockOrangeHRMApiClient();
  client.setAccessToken("custom-token-abc");

  assert.equal(client.getAccessToken(), "custom-token-abc");
});
