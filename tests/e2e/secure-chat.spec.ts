import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const PASSPHRASE = "correct horse battery staple";

test("pairs two clients, verifies fingerprints, chats, and transfers files", async ({ browser }, testInfo) => {
  const hostContext = await browser.newContext({ acceptDownloads: true });
  const joinerContext = await browser.newContext({ acceptDownloads: true });
  const host = await hostContext.newPage();
  const joiner = await joinerContext.newPage();

  try {
    await Promise.all([host.goto("/"), joiner.goto("/")]);
    await Promise.all([createIdentity(host), createIdentity(joiner)]);
    await host.getByTestId("encryption-high-assurance").click();
    await joiner.getByTestId("encryption-high-assurance").click();

    const backupDownload = host.waitForEvent("download");
    await host.getByTestId("download-backup").click();
    expect((await backupDownload).suggestedFilename()).toBe("securechat-key.json");

    await host.getByTestId("create-room").click();
    await expect(host.getByTestId("encryption-high-assurance")).toBeDisabled();
    const code = (await host.getByTestId("room-code").textContent())?.replace(/\D/g, "");
    expect(code).toMatch(/^\d{10}$/);

    await joiner.getByTestId("join-code-input").fill(code ?? "");
    await joiner.getByTestId("join-room").click();

    await expect(host.getByTestId("peer-fingerprint")).toContainText(/[A-F0-9]{4}/);
    await expect(joiner.getByTestId("peer-fingerprint")).toContainText(/[A-F0-9]{4}/);
    await expect(host.getByTestId("message-input")).toBeDisabled();
    await expect(joiner.getByTestId("message-input")).toBeDisabled();

    await host.getByTestId("verify-peer").click();
    await joiner.getByTestId("verify-peer").click();

    await expect(host.getByTestId("message-input")).toBeEnabled();
    await expect(joiner.getByTestId("message-input")).toBeEnabled();

    await host.getByTestId("message-input").fill("hello from host");
    await host.getByTestId("send-message").click();
    await expect(joiner.getByTestId("message-received").filter({ hasText: "hello from host" })).toBeVisible();

    const rejectPath = testInfo.outputPath("reject-me.txt");
    await writeFile(rejectPath, "reject me");
    await host.getByTestId("file-input").setInputFiles(rejectPath);
    await expect(joiner.getByTestId("incoming-file").filter({ hasText: "reject-me.txt" })).toBeVisible();
    await joiner.getByTestId("reject-file").click();
    await expect(host.getByTestId("outgoing-file").filter({ hasText: "rejected" })).toBeVisible();

    const cancelPath = testInfo.outputPath("cancel-me.txt");
    await writeFile(cancelPath, "cancel me");
    await host.getByTestId("file-input").setInputFiles(cancelPath);
    await expect(joiner.getByTestId("incoming-file").filter({ hasText: "cancel-me.txt" })).toBeVisible();
    await host.getByTestId("cancel-file").click();
    await expect(host.getByTestId("outgoing-file").filter({ hasText: "cancelled" })).toBeVisible();
    await expect(joiner.getByTestId("incoming-file").filter({ hasText: "cancel-me.txt" })).toHaveCount(0);

    const acceptPath = testInfo.outputPath("accept-me.txt");
    await writeFile(acceptPath, "accepted secure file");
    await host.getByTestId("file-input").setInputFiles(acceptPath);
    await expect(joiner.getByTestId("incoming-file").filter({ hasText: "accept-me.txt" })).toBeVisible();
    await joiner.getByTestId("accept-file").click();

    await expect(host.getByTestId("outgoing-file").filter({ hasText: "complete" })).toBeVisible();
    await expect(joiner.getByTestId("incoming-file").filter({ hasText: "complete" })).toBeVisible();

    const fileDownload = joiner.waitForEvent("download");
    await joiner.getByTestId("download-file").click();
    const downloadedPath = await (await fileDownload).path();
    expect(downloadedPath).toBeTruthy();
    await expect(readFile(downloadedPath ?? "", "utf8")).resolves.toBe("accepted secure file");
  } finally {
    await hostContext.close();
    await joinerContext.close();
  }
});

test("pairs two clients with manual offer and answer without short-code signaling", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const joinerContext = await browser.newContext();
  const host = await hostContext.newPage();
  const joiner = await joinerContext.newPage();

  try {
    const hostSignals: unknown[] = [];
    const joinerSignals: unknown[] = [];
    host.on("websocket", (socket) => {
      socket.on("framesent", (frame) => hostSignals.push(JSON.parse(frame.payload.toString())));
    });
    joiner.on("websocket", (socket) => {
      socket.on("framesent", (frame) => joinerSignals.push(JSON.parse(frame.payload.toString())));
    });

    await Promise.all([host.goto("/"), joiner.goto("/")]);
    await Promise.all([createIdentity(host), createIdentity(joiner)]);

    await host.getByRole("button", { name: "Manual" }).click();
    await joiner.getByRole("button", { name: "Manual" }).click();
    await expect(joiner.getByTestId("accept-manual-offer")).toBeDisabled();
    await expect(joiner.getByTestId("accept-manual-answer")).toHaveCount(0);
    await host.getByTestId("create-manual-offer").click();
    await expect(host.getByTestId("manual-offer-output")).toHaveValue(/^\{/);
    await expect(host.getByTestId("accept-manual-answer")).toBeDisabled();
    const offer = await host.getByTestId("manual-offer-output").inputValue();
    expect(JSON.parse(offer)).toMatchObject({ version: 2, type: "offer", encryptionProfile: "standard" });

    await joiner.getByTestId("manual-input").fill(offer);
    await joiner.getByTestId("accept-manual-offer").click();
    await expect(joiner.getByTestId("accept-manual-answer")).toHaveCount(0);
    const answer = await joiner.getByTestId("manual-answer-output").inputValue();
    expect(JSON.parse(answer)).toMatchObject({ version: 2, type: "answer", encryptionProfile: "standard" });

    await host.getByTestId("manual-input").fill(answer);
    await host.getByTestId("accept-manual-answer").click();

    await expect(host.getByTestId("peer-fingerprint")).toContainText(/[A-F0-9]{4}/);
    await expect(joiner.getByTestId("peer-fingerprint")).toContainText(/[A-F0-9]{4}/);
    await host.getByTestId("verify-peer").click();
    await joiner.getByTestId("verify-peer").click();

    await host.getByTestId("message-input").fill("manual hello");
    await host.getByTestId("send-message").click();
    await expect(joiner.getByTestId("message-received").filter({ hasText: "manual hello" })).toBeVisible();

    expect(hostSignals.some((signal) => isShortCodeSignal(signal))).toBe(false);
    expect(joinerSignals.some((signal) => isShortCodeSignal(signal))).toBe(false);
  } finally {
    await hostContext.close();
    await joinerContext.close();
  }
});

async function createIdentity(page: Page): Promise<void> {
  await page.getByTestId("backup-passphrase").fill(PASSPHRASE);
  await page.getByTestId("create-identity").click();
  await expect(page.getByTestId("own-fingerprint")).toContainText(/[A-F0-9]{4}/, { timeout: 60_000 });
}

function isShortCodeSignal(value: unknown): boolean {
  const signal = value as { type?: unknown };
  return (
    signal?.type === "create_room" ||
    signal?.type === "join_room" ||
    signal?.type === "offer" ||
    signal?.type === "answer" ||
    signal?.type === "ice_candidate"
  );
}
