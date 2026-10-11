# Security and private information

Run `npm run check:privacy` before committing or publishing. It also runs first in `npm run check` and CI. The check examines versionable working files and staged versions, rejects local configuration and private artifact paths, and looks for common credential, configured-project and non-example email literals. Findings report filenames and rule names without printing matched values. Generated local evidence and configuration remain ignored.

Public PNGs are recorded in `scripts/reviewed-public-assets.json`. Before adding or changing one, visually inspect the complete image for real names, faces, email addresses, invitation links, household details and transactions; use synthetic fixtures only. After review, record that file's SHA-256 in the manifest and stage both together. The check also rejects embedded EXIF/text metadata and trailing data. Do not add personal photos or private screenshots to the manifest to bypass the check. No command automatically approves new images.

This is a focused accidental-publication check, not a complete secret scanner. It cannot prove that arbitrary prose, encoded data or screenshots contain no private information, and it does not scan Git history. Continue reviewing diffs and images. CI runs after a push, so it cannot prevent data from first reaching a public repository; run the local check before committing and publishing.

The public repository contains source, schema migrations and synthetic examples. It must not contain household records, personal contact details, invitation links, production configuration, credentials or database exports.

Store local frontend configuration in `.env.local`. Frontend variables are visible to a browser user: use only the project URL and publishable key for your own environment. Keep service-role keys, database passwords and Google client secrets outside the frontend.

Database access rules and validated operations enforce household membership. Do not weaken them to resolve a client error. Use a separate development backend and synthetic records when investigating access problems.

For a suspected vulnerability, use GitHub's private vulnerability reporting option if it is enabled. Otherwise contact the maintainer privately through their profile. Do not open a public issue containing credentials, live invitation links, another person's data or a working exploit against a live household.

The JSON export in the app is not a complete restorable database backup. Operators must arrange database backup and restore procedures separately before depending on the app for important records.
