#!/usr/bin/env pwsh
#
# Run ONCE, manually, by an admin with org-level / Shared-VPC-host permissions.
# This is NOT part of CI and must never be wired into a workflow.
#
# What it does (idempotent / safe to re-run):
#   1. Attaches the prod and test projects to the Shared VPC host project as
#      service projects.
#   2. Grants each project's Cloud Run service agent (the serverless-robot
#      service account) roles/compute.networkUser on the shared subnet, so
#      gcloud run services update --network/--subnet ... (run post-deploy in
#      the deploy workflows) can attach functions to the shared VPC.
#
# Requires permissions on the host project: shared-vpc-container.

$HostProject = 'shared-vpc-container'
$Subnet      = 'shared-vpc-subnet'
$Region      = 'europe-west3'
$Projects    = @('idprojetprod', 'aibs-partenaire-testing')

foreach ($Project in $Projects) {
    Write-Host "=== Configuring $Project ==="

    # Attach as Shared VPC service project (no-op if already attached).
    gcloud compute shared-vpc associated-projects add $Project --host-project $HostProject
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  (already attached or attach skipped)"
    }

    $Num = (gcloud projects describe $Project --format="value(projectNumber)").Trim()
    $ServiceAgent = "serviceAccount:service-$Num@serverless-robot-prod.iam.gserviceaccount.com"

    # Ensure the serverless robot service account exists by enabling the Cloud Run API.
    # GCP creates service-<num>@serverless-robot-prod only after run.googleapis.com is enabled.
    gcloud services enable run.googleapis.com --project=$Project
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Warning: could not enable run.googleapis.com on $Project - service agent may not exist yet"
    }

    # Grant networkUser on the shared subnet (re-adding an existing binding is a no-op).
    gcloud compute networks subnets add-iam-policy-binding $Subnet `
        --region=$Region `
        --member=$ServiceAgent `
        --role="roles/compute.networkUser" `
        --project=$HostProject
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to grant networkUser for $Project"
    }
}

Write-Host "Done."