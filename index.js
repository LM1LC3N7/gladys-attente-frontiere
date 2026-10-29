// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/wire.js registers every handler BEFORE
// connect() and delegates to the BorderApp of src/app.js). Read-only: no
// command handler, the sources are only read.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { BorderApp } from './src/app.js';
import { wire } from './src/wire.js';

const gladys = new GladysIntegration();
const app = new BorderApp({ gladys });
wire(gladys, app, logger);

logger.info('Starting the border wait times integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
