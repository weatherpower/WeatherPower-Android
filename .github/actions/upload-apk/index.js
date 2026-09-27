// Uploads one file as a workflow artifact through the Actions artifact service (Twirp API used by
// actions/upload-artifact v4+): CreateArtifact -> PUT to the signed blob URL -> FinalizeArtifact.
"use strict";
const fs = require("fs");
const crypto = require("crypto");

const input = name => (process.env[`INPUT_${name.toUpperCase()}`] || "").trim();

function backendIds(token) {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  for (const scope of String(payload.scp || "").split(" ")) {
    const parts = scope.split(":");
    if (parts[0] === "Actions.Results" && parts.length === 3) {
      return { workflow_run_backend_id: parts[1], workflow_job_run_backend_id: parts[2] };
    }
  }
  throw new Error("ACTIONS_RUNTIME_TOKEN has no Actions.Results scope");
}

async function twirp(method, body, token, resultsOrigin) {
  const url = `${resultsOrigin}/twirp/github.actions.results.api.v1.ArtifactService/${method}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": "weatherpower-upload-apk" },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text || "{}");
    if (attempt >= 4 || (res.status < 500 && res.status !== 429)) throw new Error(`${method} failed: HTTP ${res.status} ${text}`);
    await new Promise(resolve => setTimeout(resolve, attempt * 3000));
  }
}

async function main() {
  const name = input("name");
  const file = input("path");
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  if (!token || !resultsUrl) throw new Error("Artifact service environment is missing (ACTIONS_RUNTIME_TOKEN / ACTIONS_RESULTS_URL)");
  if (!name || !file || !fs.existsSync(file)) throw new Error(`Nothing to upload at "${file}"`);

  const ids = backendIds(token);
  const origin = new URL(resultsUrl).origin;
  const data = fs.readFileSync(file);
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");

  const created = await twirp("CreateArtifact", Object.assign({ name, version: 4 }, ids), token, origin);
  const uploadUrl = created.signed_upload_url || created.signedUploadUrl;
  if (!created.ok || !uploadUrl) throw new Error(`CreateArtifact returned no upload URL: ${JSON.stringify(created)}`);

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "zip", "Content-Length": String(data.length) },
    body: data
  });
  if (!put.ok) throw new Error(`Blob upload failed: HTTP ${put.status} ${await put.text()}`);

  const finalized = await twirp("FinalizeArtifact", Object.assign({ name, size: String(data.length), hash: `sha256:${sha256}` }, ids), token, origin);
  if (!finalized.ok) throw new Error(`FinalizeArtifact was not ok: ${JSON.stringify(finalized)}`);
  const id = finalized.artifact_id || finalized.artifactId;
  console.log(`Uploaded artifact "${name}" (${data.length} bytes, sha256 ${sha256}), id ${id}`);
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Debug APK\n\nArtifact **${name}** (${(data.length / 1048576).toFixed(1)} MB): ${runUrl}/artifacts/${id}\n`);
  }
}

main().catch(error => {
  console.log(`::error::${error.message}`);
  process.exit(1);
});
