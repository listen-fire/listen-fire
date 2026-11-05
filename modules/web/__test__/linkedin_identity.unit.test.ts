import { belongsToAnotherProfile, belongsToProfile, isThin, profileSlug, readTitle } from '../linkedin_identity';

describe('readTitle', () => {
  it('strips a localised suffix: Norwegian', () => {
    const identity = readTitle('Jane Doe - CEO - Acme AS - LinkedIn Norge');
    expect(identity.organisation).toBe('Acme AS');
  });

  it('strips a localised suffix: Spanish', () => {
    const identity = readTitle('Maria Gomez - CEO - Acme SL - LinkedIn España');
    expect(identity.organisation).toBe('Acme SL');
  });

  it('never lets the localised suffix itself become the organisation (regression for the reported bug)', () => {
    const identity = readTitle(
      'Jane Doe – Co-Founder & CEO Acme … - LinkedIn Norge',
    );
    expect(identity.organisation ?? '').not.toMatch(/linkedin/i);
    expect(identity.headline ?? '').not.toMatch(/linkedin/i);
  });

  it('still strips a bare "- LinkedIn" suffix (regression)', () => {
    const identity = readTitle('Jane Doe - Founder - Acme - LinkedIn');
    expect(identity.organisation).toBe('Acme');
  });

  it('strips a suffix joined by an en dash', () => {
    const identity = readTitle('Jane Doe – Founder – Acme – LinkedIn Norge');
    expect(identity.organisation).toBe('Acme');
  });

  it('leaves a title with no LinkedIn suffix untouched', () => {
    const identity = readTitle('Jane Doe - Founder - Acme Corp');
    expect(identity.name).toBe('Jane Doe');
    expect(identity.organisation).toBe('Acme Corp');
  });
});

describe('an index entry with no headline', () => {
  it.each([
    ['Jane Doe - Berlin, Deutschland | Berufliches Profil', 'Berlin, Deutschland'],
    ['Jane Doe - München, Bayern, Deutschland | Berufliches Profil', 'München, Bayern, Deutschland'],
    ['Jane Doe - Argentina | Perfil profesional', 'Argentina'],
    ['Jane Doe - Sverige | Yrkesprofil', 'Sverige'],
    ['Jane Doe - United Kingdom | Professional Profile', 'United Kingdom'],
    ['Jane Doe – United Kingdom | Professional Profile | LinkedIn', 'United Kingdom'],
  ])('reads a location, not a role, and is thin: %s', (title, location) => {
    const identity = readTitle(title);
    expect(identity).toEqual({ name: 'Jane Doe', headline: null, role: null, organisation: null, location });
    expect(isThin(identity)).toBe(true);
  });

  it('keeps the role and organisation when the label follows a real headline', () => {
    expect(readTitle('Jane Doe - Founder - Acme | Professional Profile')).toEqual({
      name: 'Jane Doe',
      headline: 'Founder - Acme',
      role: 'Founder',
      organisation: 'Acme',
      location: null,
    });
  });

  it('leaves a headline written with bars alone', () => {
    const identity = readTitle('Jane Doe - Co-Founder Acme | Lawyer | ex BCG');
    expect(identity.role).toBe('Co-Founder Acme | Lawyer | ex BCG');
    expect(identity.location).toBeNull();
    expect(isThin(identity)).toBe(false);
  });
});

describe('isThin', () => {
  it.each([
    'Jane Doe - Stealth | LinkedIn',
    'Jane Doe - Stealth Startup | LinkedIn',
    'Jane Doe - Self-employed | LinkedIn',
  ])('counts a placeholder headline as nothing to check against: %s', (title) => {
    expect(isThin(readTitle(title))).toBe(true);
  });

  it('counts a real role as something to check against', () => {
    expect(isThin(readTitle('Jane Doe - Founder - Acme | LinkedIn'))).toBe(false);
  });
});

describe('whose address this is', () => {
  it.each([
    'https://www.linkedin.com/in/jane-doe',
    'https://de.linkedin.com/in/Jane-Doe/details/experience',
    'https://www.linkedin.com/posts/jane-doe_launch-activity-1-abc',
    'https://uk.linkedin.com/posts/Jane-Doe_launch',
  ])('%s is jane-doe', (link) => {
    expect(belongsToProfile(link, 'jane-doe')).toBe(true);
    expect(belongsToAnotherProfile(link, 'jane-doe')).toBe(false);
  });

  it.each([
    'https://www.linkedin.com/in/jane-doe-42',
    'https://www.linkedin.com/posts/jane-doe-42_launch-activity-1-abc',
    'https://www.linkedin.com/posts/jane-doey_launch',
  ])('%s is somebody else', (link) => {
    expect(belongsToProfile(link, 'jane-doe')).toBe(false);
    expect(belongsToAnotherProfile(link, 'jane-doe')).toBe(true);
  });

  it.each(['https://news.example/jane-doe', 'https://www.linkedin.com/company/acme', 'https://evil.example/linkedin.com/in/jane-doe'])(
    '%s says nothing either way',
    (link) => {
      expect(belongsToProfile(link, 'jane-doe')).toBe(false);
      expect(belongsToAnotherProfile(link, 'jane-doe')).toBe(false);
    },
  );

  it('reads an address that will not decode as written, rather than throwing', () => {
    expect(profileSlug('https://www.linkedin.com/in/jane%E9-doe')).toBe('jane%E9-doe');
  });
});
