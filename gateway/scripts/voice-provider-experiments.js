#!/usr/bin/env node
"use strict";

const {
  currentConnectionTopology,
  providerExperimentStatus,
  speechToSpeechContract,
} = require("../lib/voice-provider-experiments");

console.log(JSON.stringify({
  ok: true,
  paid_calls_made: false,
  contract: speechToSpeechContract(),
  topology: currentConnectionTopology(),
  providers: providerExperimentStatus(process.env),
}, null, 2));
