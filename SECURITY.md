# Security and private information

The public repository contains source, schema migrations and synthetic examples. It must not contain household records, personal contact details, invitation links, production configuration, credentials or database exports.

Store local frontend configuration in `.env.local`. Frontend variables are visible to a browser user: use only the project URL and publishable key for your own environment. Keep service-role keys, database passwords and Google client secrets outside the frontend.

Database access rules and validated operations enforce household membership. Do not weaken them to resolve a client error. Use a separate development backend and synthetic records when investigating access problems.

For a suspected vulnerability, use GitHub's private vulnerability reporting option if it is enabled. Otherwise contact the maintainer privately through their profile. Do not open a public issue containing credentials, live invitation links, another person's data or a working exploit against a live household.

The JSON export in the app is not a complete restorable database backup. Operators must arrange database backup and restore procedures separately before depending on the app for important records.
