# Contributing

Run `npm ci`, `npm test`, and `npm run build` before a pull request. Keep the app static and keep imported PCB data local. Do not add analytics or automatic board uploads.

Parser changes should include a small, redistributable fixture and a test for units, origin or side when those are involved. Use synthetic files or include the original design's redistribution license. Never commit another person's confidential board.

For a bug report, include CAD/export settings, the error message and a sanitized minimal example. Describe what you expected to see and which side/reference is affected.

Generated `dist/`, dependencies and release ZIPs do not belong in source commits. The build includes third-party license notices.
