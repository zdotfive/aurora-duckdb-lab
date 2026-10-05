#!/usr/bin/env node
import { App, LegacyStackSynthesizer } from 'aws-cdk-lib';
import { AuroraDuckdbLabStack } from '../lib/lab-stack';

// region-agnostic on purpose: deploy wherever your CLI profile points
const app = new App({ analyticsReporting: false });

// No assets in this stack, so it doesn't need `cdk bootstrap`: it deploys with the
// credentials of your CLI profile instead of the bootstrap roles.
// That also means nothing is left behind in the account after `cdk destroy`.
new AuroraDuckdbLabStack(app, 'AuroraDuckdbLab', {
  synthesizer: new LegacyStackSynthesizer(),
  instanceClass: app.node.tryGetContext('instanceClass') ?? 'r8gd.xlarge',
  scaleFactor: Number(app.node.tryGetContext('sf') ?? 10),
});
