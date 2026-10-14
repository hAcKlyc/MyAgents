# IP website trial download metadata

The public website is https://140.143.183.232/ and its download page is /download/. User explicitly chose the IP origin; neither publishing nor runtime requires the old Sites account. Desktop APP_WEBSITE_URL already uses this IP.

The static design source remains the accepted immutable website source a5cb41f09fde9372c3d1c271d86ddce4196698c3. `trial-release.json` is the MoXBots-owned download-channel projection. It names an immutable GitHub release asset and its exact size/SHA256; it does not contain credentials or enable model execution. Preserve old release assets and existing hashed manifests for cached pages/rollback.

For an update, validate the asset against the signed/extracted local delivery and GitHub asset digest/size, publish the accepted GitHub release, then overlay only the content-addressed JSON and the download HTML body data-release-manifest reference onto the existing static base. Use a new immutable directory, hold the website/Nginx/cloud maintenance locks, verify the current symlink with CAS, and atomically switch it. Keep the previous target and a selective rollback receipt. Do not modify Nginx routes, TLS, authentication, cloud executable or Host permissions.

Validate the public /download/ UI version/link and JSON hash, slash redirect, asset MIME/hash, unchanged /health and /admin, and unknown/private-path404. The local and GitHub-reported full archive digest agree; a slow partial network readback is not a verified full download. Model API key and paid invocation remain unconfigured/unexecuted on the accepted Host.
