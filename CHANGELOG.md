# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Conventional Commits](https://www.conventionalcommits.org/).
This file is generated from the git history with git-cliff — do not edit by hand.

## [Unreleased]

### Added
- Persist interrupted live turns into canonical history
- Wire brain memory into live voice sessions
- Persist live voice browser continuity
- Route browser voice through gateway sessions
- Add Moa launcher assets
- Add Moa waitlist site
- Waitlist landing page with D1 store and Resend confirmation
- Golden moa as the icon and overlay mark, wake beep on engage
- Auto-reload in your own Chrome on file change
- Ship Aggie landing at agee.app on the agee-app project

### Documentation
- Record interrupted live-turn handoff behavior
- Require committing completed agent changes

### Fixed
- Repath deploy/smoke for flattened layout and allow NODE_BINARY override
- Commit assistant voice launch turns
- Fast-path assistant voice launch
- Make mobile voice overlay continuous
- Stop stale voice playback
- Stabilize live voice profile controls
- Honor live response modality profile
- Keep gateway voice smoke deployable
- Unify brand on the agee mark across hero, header, icons
- Keep Aggie voice deploy current
- Keep composer live while replies stream
- Align waitlist copy with Aggie
- Proxy live voice through background

