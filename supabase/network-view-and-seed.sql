-- Open profiles + survey_state to public SELECT so the network view
-- can show all hubs. Write access stays own-row.
-- Then seed 5 dummy hubs for testing the network view.

-- =====================================================================
-- Public SELECT on profiles + survey_state
-- =====================================================================
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_select_public" on public.profiles;
create policy "profiles_select_public"
  on public.profiles for select
  using (true);

drop policy if exists "survey_state_select_own" on public.survey_state;
drop policy if exists "survey_state_select_public" on public.survey_state;
create policy "survey_state_select_public"
  on public.survey_state for select
  using (true);

-- =====================================================================
-- Seed 5 dummy hubs
-- =====================================================================
-- We insert into auth.users (the on_auth_user_created trigger creates
-- the matching profile + survey_state rows automatically), then update
-- those rows with varied realistic content.
--
-- All dummies use the same fixed UUIDs so re-running this script is
-- idempotent (ON CONFLICT DO NOTHING for the user insert, then UPDATE
-- against those known ids).

-- Helper: insert an auth.users row with minimal fields
do $$
declare
  dummies jsonb := jsonb_build_array(
    jsonb_build_object('id', '11111111-1111-1111-1111-111111111111', 'email', 'anna@dummy.sovereignty-hub.test'),
    jsonb_build_object('id', '22222222-2222-2222-2222-222222222222', 'email', 'marcus@dummy.sovereignty-hub.test'),
    jsonb_build_object('id', '33333333-3333-3333-3333-333333333333', 'email', 'kai@dummy.sovereignty-hub.test'),
    jsonb_build_object('id', '44444444-4444-4444-4444-444444444444', 'email', 'priya@dummy.sovereignty-hub.test'),
    jsonb_build_object('id', '55555555-5555-5555-5555-555555555555', 'email', 'sam@dummy.sovereignty-hub.test')
  );
  d jsonb;
begin
  for d in select * from jsonb_array_elements(dummies) loop
    insert into auth.users (
      id, instance_id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin
    ) values (
      (d->>'id')::uuid,
      '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated',
      d->>'email',
      crypt('dummy-password-not-real', gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"dummy":true}'::jsonb,
      false
    )
    on conflict (id) do nothing;
  end loop;
end $$;

-- The trigger should have created profile + survey_state rows for each.
-- Now populate them with varied content.

-- Hub 1: Anna — Water-focused builder, getting started
update public.profiles set
  hub_name = 'Anna''s Hub',
  hub_email = 'anna@dummy.sovereignty-hub.test',
  hub_link = '',
  updated_at = now()
where id = '11111111-1111-1111-1111-111111111111';

update public.survey_state set
  answers = jsonb_build_object(
    '0-0', 'build',   '0-1', 'build',   '0-2', 'survive',
    '1-0', 'survive', '1-1', 'survive',
    '2-0', 'build',   '2-1', 'survive',
    '4-0', 'survive',
    '5-0', 'survive',
    '11-0', 'build',  '11-1', 'survive'
  ),
  descriptions = jsonb_build_object(
    '0-0', 'I keep 200L stored under the stairs and have a ceramic filter that has run for three years without complaint.',
    '0-1', 'Working rain catch off the shed roof — about 1000L of storage and a first-flush diverter.',
    '1-0', 'Three months of dry goods on rotation. The hard part is keeping the inventory list current.',
    '4-0', 'A solar panel and a small battery — enough to keep the radio and lights going for a week.',
    '11-0', 'A small lending library of self-reliance books and a stack of laminated quick-reference cards we hand out.'
  ),
  cursor = 14,
  max_reached = 14,
  updated_at = now()
where user_id = '11111111-1111-1111-1111-111111111111';

-- Hub 2: Marcus — Manufacturing/Energy heavy, deeper into Production
update public.profiles set
  hub_name = 'Marcus Workshop',
  hub_email = 'marcus@dummy.sovereignty-hub.test',
  hub_link = '',
  updated_at = now()
where id = '22222222-2222-2222-2222-222222222222';

update public.survey_state set
  answers = jsonb_build_object(
    '3-0', 'build',  '3-1', 'build',   '3-3', 'survive',
    '6-0', 'build',  '6-1', 'build',   '6-3', 'build',   '6-4', 'survive',
    '0-0', 'survive',
    '1-0', 'survive',
    '5-3', 'survive'
  ),
  descriptions = jsonb_build_object(
    '3-0', 'I have an 800W solar array, a small battery bank, and an inverter that has carried us through three outages.',
    '3-1', 'Spare panels, charge controllers, and inverters in a Faraday-shielded box. Enough to seed two more households.',
    '6-0', 'A small FDM printer running daily; I make replacement parts for neighbours rather than ordering them.',
    '6-3', 'Selling 3D-printed brackets and enclosures locally — modest but steady orders every week.',
    '6-4', 'Just started teaching a Sunday workshop on basic 3D printing. Five people the first time, eight the next.'
  ),
  cursor = 28,
  max_reached = 28,
  updated_at = now()
where user_id = '22222222-2222-2222-2222-222222222222';

-- Hub 3: Kai — Comms + Knowledge specialist
update public.profiles set
  hub_name = 'Kai Mesh',
  hub_email = 'kai@dummy.sovereignty-hub.test',
  hub_link = '',
  updated_at = now()
where id = '33333333-3333-3333-3333-333333333333';

update public.survey_state set
  answers = jsonb_build_object(
    '5-0', 'build',  '5-1', 'build',   '5-3', 'build',   '5-6', 'survive',
    '11-0', 'build', '11-1', 'build',  '11-3', 'survive',
    '0-0', 'survive',
    '1-0', 'survive'
  ),
  descriptions = jsonb_build_object(
    '5-0', 'Running an off-grid mesh radio network across about 15 houses on my hill. Tested through two power cuts.',
    '5-1', 'Programmed handhelds, spare antennas, and a laminated frequency card the whole group works from.',
    '5-3', 'Build and program mesh nodes for new joiners — about one a month, sometimes more.',
    '5-6', 'Experimenting with running a small language model over the mesh as a community AI assistant.',
    '11-0', 'A small offline library — encyclopedia, medical references, how-to manuals — on a stack of SD cards.',
    '11-1', 'Two Raspberry Pis with the full offline library, ready to hand to anyone who needs them.'
  ),
  cursor = 35,
  max_reached = 35,
  updated_at = now()
where user_id = '33333333-3333-3333-3333-333333333333';

-- Hub 4: Priya — Food + Medicine focused
update public.profiles set
  hub_name = 'Priya Garden',
  hub_email = 'priya@dummy.sovereignty-hub.test',
  hub_link = '',
  updated_at = now()
where id = '44444444-4444-4444-4444-444444444444';

update public.survey_state set
  answers = jsonb_build_object(
    '1-0', 'build',  '1-1', 'build',   '1-3', 'survive', '1-5', 'survive',
    '4-0', 'build',  '4-1', 'build',   '4-5', 'survive',
    '0-0', 'survive',
    '11-0', 'survive'
  ),
  descriptions = jsonb_build_object(
    '1-0', 'A 400m² garden producing year-round — leafy greens through winter, fruit and grains through summer.',
    '1-1', 'Six months of stored harvest in jars and dehydrated form, plus a seed library of 30+ varieties.',
    '1-3', 'Selling vegetable seedlings and dried herbs at the local market on weekends.',
    '4-0', 'A medicinal herb garden and a first-aid kit I have actually used. Trained in basic wound care.',
    '4-1', 'Tinctures, salves, and dried herbs in labelled jars — enough for our household for a year.'
  ),
  cursor = 21,
  max_reached = 21,
  updated_at = now()
where user_id = '44444444-4444-4444-4444-444444444444';

-- Hub 5: Sam — Governance + Culture focused, broad but shallow
update public.profiles set
  hub_name = 'Sam Commons',
  hub_email = 'sam@dummy.sovereignty-hub.test',
  hub_link = '',
  updated_at = now()
where id = '55555555-5555-5555-5555-555555555555';

update public.survey_state set
  answers = jsonb_build_object(
    '10-0', 'build', '10-1', 'survive', '10-5', 'survive',
    '12-0', 'build', '12-1', 'build',   '12-3', 'survive',
    '0-0', 'survive',
    '1-0', 'survive',
    '5-0', 'survive'
  ),
  descriptions = jsonb_build_object(
    '10-0', 'We have a written agreement among 12 households for shared decision-making and dispute resolution.',
    '10-1', 'Charter, voting procedures, and meeting templates all printed and stored in a binder at the hub.',
    '12-0', 'A weekly community dinner that has run for over a year — rotates between houses, anyone can bring a story.',
    '12-1', 'Instruments, board games, art supplies, songbooks all kept in a shared room people drop into.',
    '12-3', 'Recording a podcast about local stories — slow but steady, three episodes out so far.'
  ),
  cursor = 18,
  max_reached = 18,
  updated_at = now()
where user_id = '55555555-5555-5555-5555-555555555555';
