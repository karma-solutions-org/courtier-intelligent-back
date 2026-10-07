/**
 * Manifest of Cloud Functions that must egress through the shared VPC.
 *
 * Background: the Firebase Functions v2 SDK only supports the named
 * `vpcConnector` option, NOT Direct VPC egress. We use Direct VPC egress to
 * route Elasticsearch traffic out through the shared VPC's Cloud NAT (so it
 * exits on the whitelisted static IP). Because the SDK cannot express this,
 * the VPC configuration is applied POST-DEPLOY via `gcloud run services update`
 * in the deploy workflows, not in the function code's options.
 *
 * This file is the single source of truth for which functions need that
 * post-deploy VPC step. Only functions that talk to Elasticsearch belong here;
 * everything else must stay off the VPC.
 *
 * Entries are the deployed (namespaced) function names exactly as exported from
 * `index.ts` (`<group>-<functionName>`). The `list-vpc` npm script lowercases
 * each entry to the Cloud Run service-name convention before the workflow loops
 * over them. When adding/removing an Elasticsearch function, update this list.
 */
export const VPC_FUNCTIONS: string[] = [
  // src/functions/sepa/sepa.ts
  
];

/**
 * Max instances for every function in `VPC_FUNCTIONS`.
 *
 * Direct VPC egress draws one subnet IP per instance, but the effective
 * consumption is much higher than the instance count: Cloud Run uses ~2x as
 * many IPs as instances at steady state, reserves them in blocks of 16, and
 * holds them for up to 20 minutes after a revision scales down. The shared
 * subnet (`shared-vpc-subnet`) is shared with the other service projects, so
 * leaving these on the platform default of 100 lets this project alone claim
 * enough addresses to exhaust it and break instance startup with
 * "insufficient free IP addresses in the subnetwork".
 *
 * Keep this bound to what the Elasticsearch endpoints actually need. Any raise
 * has to be weighed against the subnet's free space, not just this project.
 */
export const VPC_MAX_INSTANCES = 10;
