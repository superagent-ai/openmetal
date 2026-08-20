import { expect, test } from "@playwright/test";
import {
  createAdminClient,
  createConfirmedUser,
  deleteUser,
  insertCommittedProjectEvent,
  loadTestEnv,
} from "@openmetal/testkit";
import { MetalClient } from "@openmetal/sdk";

const env = loadTestEnv();

test("protects the dashboard when unauthenticated", async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/login/);
  await page.close();
});

test("authenticated vertical slice", async ({ page, context }) => {
  test.setTimeout(90_000);
  const user = await createConfirmedUser(env);
  const createdUsers = [user.user.id];
  try {
    const admin = createAdminClient(env);
    const link = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: user.email,
    });
    const tokenHash = link.data.properties?.hashed_token;
    expect(tokenHash).toBeTruthy();

    await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=email`);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    await expect(page.getByText("Control plane")).toBeVisible();
    await expect(page.getByTestId("api-meta")).toContainText("API");

    const orgName = `Playwright ${crypto.randomUUID().slice(0, 6)}`;
    await page.getByLabel("Name").first().fill(orgName);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page.getByTestId("organization-selector")).toContainText(orgName);

    const projectName = `Alpha ${crypto.randomUUID().slice(0, 6)}`;
    await page.getByLabel("Name").nth(1).fill(projectName);
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByTestId("project-list")).toContainText(projectName);
    await expect(page.getByTestId("latest-event")).toContainText("project.created", {
      timeout: 20_000,
    });

    const latest = JSON.parse(await page.getByTestId("latest-event").innerText()) as {
      organization_id: string;
      project_id: string;
      event_id: string;
    };
    await page.goto("/dashboard/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    const gapEventId = crypto.randomUUID();
    await insertCommittedProjectEvent(
      {
        eventId: gapEventId,
        organizationId: latest.organization_id,
        projectId: latest.project_id,
        actorId: user.user.id,
        data: { recovered: true },
      },
      env,
    );

    const ownerMetal = new MetalClient({
      baseUrl: env.METAL_API_URL,
      accessToken: async () => user.accessToken,
    });
    await expect
      .poll(async () => {
        const page = await ownerMetal.events.list({ projectId: latest.project_id, limit: 50 });
        return page.events.some((item) => item.event_id === gapEventId);
      })
      .toBe(true);

    await page.goto("/dashboard");
    await page.getByTestId("project-list").getByRole("button").first().click();
    await expect(page.getByTestId("latest-event")).toContainText(gapEventId, { timeout: 20_000 });
    await expect(page.getByTestId("latest-event")).toContainText("recovered");

    const outsider = await createConfirmedUser(env);
    createdUsers.push(outsider.user.id);
    const metal = new MetalClient({
      baseUrl: env.METAL_API_URL,
      accessToken: async () => outsider.accessToken,
    });
    await expect(metal.organizations.list()).resolves.toMatchObject({ organizations: [] });

    await page.goto("/dashboard/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.goto("/login");
    await expect(page).toHaveURL(/dashboard/);

    const second = await context.newPage();
    await second.goto("/dashboard");
    await expect(second.getByTestId("latest-event")).toBeVisible();
  } finally {
    await Promise.all(createdUsers.map((id) => deleteUser(id, env)));
  }
});
