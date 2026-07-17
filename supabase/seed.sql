-- NON-PRODUCTION deterministic sandbox fixtures. Run scripts/create-sandbox-credentials.ts afterward.
insert into public.partners(id,name,status) values('ptr_sandbox_demo','Restec Sandbox Demo','active') on conflict(id) do update set name=excluded.name;
insert into public.restaurants(id,partner_id,name) values('rst_sandbox_demo','ptr_sandbox_demo','Sandbox Restaurant') on conflict(id) do nothing;
insert into public.locations(id,restaurant_id,environment,name,private_location_reference) values('loc_sandbox_demo','rst_sandbox_demo','sandbox','Sandbox Location','00000000-0000-4000-8000-000000000101') on conflict(id) do nothing;
insert into public.pos_connections(id,partner_id,location_id,environment,connector_type,connector_version,encrypted_configuration,status,private_connection_reference) values
('con_sandbox_canonical','ptr_sandbox_demo','loc_sandbox_demo','sandbox','canonical_rest','1.0.0','local_setup_required','active','00000000-0000-4000-8000-000000000201'),
('con_sandbox_mock','ptr_sandbox_demo','loc_sandbox_demo','sandbox','mock_pos','1.0.0','local_setup_required','active','00000000-0000-4000-8000-000000000202')
on conflict(id) do nothing;
insert into public.pos_tables(id,location_id,name) values
('tbl_sandbox_01','loc_sandbox_demo','Table 1'),('tbl_sandbox_02','loc_sandbox_demo','Table 2'),('tbl_sandbox_03','loc_sandbox_demo','Table 3'),('tbl_sandbox_04','loc_sandbox_demo','Table 4'),('tbl_sandbox_05','loc_sandbox_demo','Table 5') on conflict(id) do nothing;
insert into public.table_mappings(connection_id,external_table_id,restec_table_id,private_table_reference,active) values
('con_sandbox_canonical','EXT-01','tbl_sandbox_01','00000000-0000-4000-8000-000000000301',true),
('con_sandbox_canonical','EXT-02','tbl_sandbox_02','00000000-0000-4000-8000-000000000302',true),
('con_sandbox_canonical','EXT-03','tbl_sandbox_03','00000000-0000-4000-8000-000000000303',true),
('con_sandbox_canonical','EXT-04','tbl_sandbox_04','00000000-0000-4000-8000-000000000304',true),
('con_sandbox_canonical','EXT-05','tbl_sandbox_05','00000000-0000-4000-8000-000000000305',true) on conflict(connection_id,external_table_id) do nothing;
insert into public.webhook_endpoints(id,connection_id,url,encrypted_signing_secret,status) values
('00000000-0000-4000-8000-000000000401','con_sandbox_canonical','https://example.invalid/restec-webhook','local_setup_required','active'),
('00000000-0000-4000-8000-000000000402','con_sandbox_canonical','https://disabled.example.invalid/restec-webhook','local_setup_required','disabled') on conflict(id) do nothing;
