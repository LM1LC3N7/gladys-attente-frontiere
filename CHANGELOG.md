# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-30

### Added

- First version: the wait times of the land border crossings between Canada
  and the U.S., both ways, from the open data of the CBSA (to Canada, English
  and French CSV) and of CBP (to the U.S., JSON feed, Canadian border only).
  One device per crossing and direction: waits in minutes (travellers and
  commercial; passenger, NEXUS, Ready Lane, commercial and FAST) and a status
  text. Each reading published once, only while at most 2 hours old; closed,
  not applicable or missing values never published as numbers. One read every
  10 to 60 minutes (kept across restarts), one request at a time, bounded,
  conditional headers for the CBSA, 429/5xx pause per source, frozen CBP feed
  detected. Read-only. CBP local times turned into UTC with the zone of each
  port (exact across the changes of time). One publication at a time, each
  reading marked before it is sent (never twice, 250 states a minute at
  most, fair rotation beyond); a device created gets its fresh readings at
  once.

[Unreleased]: https://github.com/LM1LC3N7/gladys-attente-frontiere/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-attente-frontiere/releases/tag/v0.1.1
