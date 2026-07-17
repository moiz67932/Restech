# Portal Security Status

The portal is still a UI foundation. `PortalAdminService` defines key, webhook, location, mapping, delivery, replay, audit and sandbox operations; its current implementation is disabled. No unauthenticated portal mutation route exists. Enabling it requires an approved identity provider, role claims, session/CSRF policy, step-up authentication, audit retention and rate limits.
