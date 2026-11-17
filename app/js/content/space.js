import { M, O, P, S, L } from './helpers.js';
export const cats = [
  { id: 'solar', name: 'Solar System', emoji: '☀️' }, { id: 'planet', name: 'Planets', emoji: '🪐' },
  { id: 'star', name: 'Stars', emoji: '⭐' }, { id: 'galaxy', name: 'Galaxies', emoji: '🌌' },
  { id: 'astro', name: 'Astronauts', emoji: '👩‍🚀' }, { id: 'mission', name: 'Space Missions', emoji: '🚀' },
  { id: 'sat', name: 'Satellites', emoji: '🛰️' }, { id: 'astron', name: 'Astronomy', emoji: '🔭' },
];
const D = { certainty: 'debated' };
export const bank = [
  M('solar', 1, 'What is at the centre of our Solar System?', 'The Sun', ['Earth', 'The Moon', 'Jupiter'], 'The Sun holds about 99.8% of the Solar System’s mass.', { img: '☀️' }),
  M('solar', 1, 'Which planet do we live on?', 'Earth', ['Mars', 'Venus', 'Saturn'], 'Earth is the third planet from the Sun.', { img: '🌍' }),
  O('solar', 2, 'Order the planets from closest to the Sun.', ['Mercury', 'Venus', 'Earth', 'Mars'], 'Mercury, Venus, Earth, Mars.'),
  O('solar', 3, 'Order these planets from closest to the Sun.', ['Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'], 'Mars, Jupiter, Saturn, Uranus, Neptune.'),
  M('solar', 3, 'Where is the asteroid belt?', 'Between Mars and Jupiter', ['Between Earth and Mars', 'Beyond Neptune', 'Between Venus and Earth'], 'Most asteroids orbit between Mars and Jupiter.'),
  M('solar', 4, 'What is the Moon’s main cause of Earth’s ocean tides?', 'Its gravity (with a smaller effect from the Sun)', ['Its light', 'Its magnetic field', 'Its atmosphere'], 'The Moon’s gravitational pull creates tidal bulges.'),
  M('solar', 4, 'How long does light from the Sun take to reach Earth?', 'About 8 minutes 20 seconds', ['About 8 seconds', 'About 8 hours', 'About 1 day'], 'The Sun is ~150 million km away.'),
  M('solar', 5, 'What is Pluto classified as since 2006?', 'A dwarf planet', ['A moon', 'A star', 'An asteroid'], 'The IAU reclassified Pluto in 2006.'),
  M('planet', 1, 'Which planet is known as the Red Planet?', 'Mars', ['Venus', 'Jupiter', 'Mercury'], 'Iron oxide (rust) gives Mars its red colour.', { img: '🔴' }),
  M('planet', 1, 'Which planet has famous rings?', 'Saturn', ['Mars', 'Venus', 'Mercury'], 'Saturn has the most spectacular ring system.', { img: '🪐' }),
  M('planet', 2, 'Which is the largest planet in our Solar System?', 'Jupiter', ['Saturn', 'Earth', 'Neptune'], 'Jupiter could hold over 1,300 Earths.'),
  M('planet', 2, 'Which planet is closest to the Sun?', 'Mercury', ['Venus', 'Mars', 'Earth'], 'Mercury orbits the Sun in 88 Earth days.'),
  M('planet', 3, 'Which planet is the hottest?', 'Venus', ['Mercury', 'Mars', 'Jupiter'], 'Venus’s thick CO₂ atmosphere traps heat (~465 °C).'),
  M('planet', 3, 'Which planet spins on its side?', 'Uranus', ['Neptune', 'Saturn', 'Mars'], 'Uranus’s axis is tilted about 98°.'),
  M('planet', 4, 'Which moon of Saturn has a thick atmosphere?', 'Titan', ['Europa', 'Phobos', 'Io'], 'Titan’s atmosphere is mostly nitrogen.'),
  M('planet', 4, 'Where is Olympus Mons, the tallest volcano known in the Solar System?', 'Mars', ['Venus', 'Earth', 'Io'], 'Olympus Mons is ~22 km high.'),
  M('planet', 5, 'Which two planets are called ice giants?', 'Uranus and Neptune', ['Jupiter and Saturn', 'Mars and Venus', 'Earth and Mercury'], 'They contain more “ices” (water, ammonia, methane) than gas giants.'),
  S('planet', 3, 'Sort each planet: rocky or gas/ice giant.', ['Rocky', 'Gas / ice giant'], [['Mercury', 0], ['Earth', 0], ['Mars', 0], ['Jupiter', 1], ['Saturn', 1], ['Neptune', 1]], 'The four inner planets are rocky; the four outer planets are giants.'),
  M('star', 1, 'What is the Sun?', 'A star', ['A planet', 'A moon', 'A comet'], 'The Sun is a G-type main-sequence star.', { img: '⭐' }),
  M('star', 2, 'Why do stars twinkle when seen from Earth?', 'Earth’s atmosphere bends their light', ['They blink', 'They spin quickly', 'Clouds block them'], 'Atmospheric turbulence makes the light flicker.'),
  M('star', 3, 'What is a light-year?', 'The distance light travels in one year', ['A year of sunlight', 'A unit of time', 'The age of a star'], 'About 9.46 trillion km.'),
  M('star', 4, 'What will our Sun eventually become after its red giant stage?', 'A white dwarf', ['A black hole', 'A supernova', 'A neutron star'], 'The Sun isn’t massive enough for a supernova.'),
  M('star', 5, 'What is the name of the closest star to the Sun?', 'Proxima Centauri', ['Sirius', 'Betelgeuse', 'Polaris'], 'About 4.24 light-years away.'),
  M('galaxy', 2, 'What is the name of our galaxy?', 'The Milky Way', ['Andromeda', 'Triangulum', 'Whirlpool'], 'Our Solar System lies in the Milky Way.', { img: '🌌' }),
  M('galaxy', 3, 'Which large galaxy is the nearest to the Milky Way?', 'Andromeda', ['Whirlpool', 'Sombrero', 'Pinwheel'], 'Andromeda is about 2.5 million light-years away.'),
  M('galaxy', 4, 'What is the shape of the Milky Way?', 'A barred spiral', ['A perfect sphere', 'An ellipse with no arms', 'A cube'], 'Astronomers describe it as a barred spiral galaxy.'),
  M('galaxy', 5, 'What is thought to lie at the centre of the Milky Way?', 'A supermassive black hole (Sagittarius A*)', ['A giant star', 'Another galaxy', 'Empty space'], 'Observations of orbiting stars confirm it.'),
  M('astro', 1, 'Who was the first human in space (1961)?', 'Yuri Gagarin', ['Neil Armstrong', 'Buzz Aldrin', 'Alan Shepard'], 'He orbited Earth aboard Vostok 1.'),
  M('astro', 2, 'Who was the first person to walk on the Moon?', 'Neil Armstrong', ['Buzz Aldrin', 'Yuri Gagarin', 'John Glenn'], 'Apollo 11, 20 July 1969.'),
  M('astro', 3, 'Who was the first Indian to travel in space (1984)?', 'Rakesh Sharma', ['Kalpana Chawla', 'Sunita Williams', 'Ravish Malhotra'], 'He flew on Soyuz T-11.'),
  M('astro', 4, 'Which Indian-born astronaut died in the Columbia disaster in 2003?', 'Kalpana Chawla', ['Sunita Williams', 'Rakesh Sharma', 'Shubhanshu Shukla'], 'STS-107.'),
  M('mission', 2, 'Which space agency launched Chandrayaan missions?', 'ISRO', ['NASA', 'ESA', 'JAXA'], 'The Indian Space Research Organisation.', { img: '🚀' }),
  M('mission', 3, 'Which mission made India the first country to reach Mars orbit on its first attempt (2014)?', 'Mangalyaan (Mars Orbiter Mission)', ['Chandrayaan-1', 'Aditya-L1', 'Gaganyaan'], 'It entered Mars orbit on 24 September 2014.'),
  M('mission', 3, 'Chandrayaan-3 landed near which region of the Moon in August 2023?', 'The south polar region', ['The equator', 'The far-side centre', 'The north pole'], 'It landed on 23 August 2023 at a high southern latitude.'),
  M('mission', 4, 'What was the name of the first artificial satellite (1957)?', 'Sputnik 1', ['Explorer 1', 'Vostok 1', 'Apollo 11'], 'Launched by the Soviet Union.'),
  M('mission', 5, 'Which spacecraft is the farthest human-made object from Earth?', 'Voyager 1', ['Hubble', 'ISS', 'New Horizons'], 'Voyager 1 entered interstellar space in 2012.'),
  M('sat', 1, 'What do we call an object that orbits a planet?', 'A satellite', ['A comet', 'A galaxy', 'A nebula'], 'The Moon is Earth’s natural satellite.', { img: '🛰️' }),
  M('sat', 2, 'Which satellites help your phone map app know where you are?', 'GPS/navigation satellites', ['Weather satellites', 'Spy satellites only', 'The Moon'], 'GNSS satellites such as GPS and NavIC provide positions.'),
  M('sat', 3, 'What is the International Space Station (ISS)?', 'A crewed research laboratory orbiting Earth', ['A telescope on the Moon', 'A rocket', 'A space hotel only'], 'It orbits at ~400 km altitude.'),
  M('sat', 4, 'Which space telescope, launched in 1990, has taken famous deep-space images?', 'Hubble Space Telescope', ['James Webb', 'Kepler', 'Voyager'], 'Hubble orbits Earth.'),
  M('astron', 2, 'What causes day and night on Earth?', 'Earth spinning on its axis', ['Earth orbiting the Sun', 'The Moon blocking the Sun', 'The Sun moving'], 'Earth rotates once about every 24 hours.'),
  M('astron', 3, 'What causes the seasons?', 'Earth’s tilted axis', ['Distance from the Sun only', 'The Moon', 'Solar flares'], 'The 23.5° tilt changes how directly sunlight hits each hemisphere.'),
  M('astron', 3, 'A solar eclipse happens when…', 'The Moon passes between the Sun and Earth', ['Earth passes between Sun and Moon', 'Clouds cover the Sun', 'The Sun turns off'], 'The Moon’s shadow falls on Earth.'),
  M('astron', 4, 'How long does the Moon take to orbit Earth?', 'About 27.3 days', ['24 hours', '365 days', '7 days'], 'The sidereal month is ~27.3 days; phases repeat every ~29.5.'),
  L('mission', 3, 'Mission Builder: Moon landing', 'Plan the mission to land on the Moon.', [
    { label: 'Launch vehicle', options: ['Rocket', 'Hot-air balloon', 'Aeroplane'], answer: 0 }, { label: 'Destination', options: ['Moon', 'The Sun', 'Jupiter’s core'], answer: 0 }, { label: 'Crew must wear', options: ['Pressure suits', 'Swimsuits', 'Regular clothes'], answer: 0 }], 'Rockets escape gravity, the Moon has no breathable air, and suits protect crew.'),
  L('planet', 4, 'Planet Probe: Mars explorer', 'Prepare a rover mission to Mars.', [
    { label: 'Power source', options: ['Solar panels / RTG', 'Coal engine', 'Petrol only'], answer: 0 }, { label: 'Landing needs', options: ['Parachute and retro-rockets', 'A runway only', 'A boat'], answer: 0 }, { label: 'Scientists look for', options: ['Signs of past water', 'Cities', 'Oceans of lava'], answer: 0 }], 'Mars rovers use solar power or RTGs and entry–descent–landing systems; water traces matter for life studies.'),
  L('sat', 4, 'Orbit Lab: choose a satellite', 'Match the satellite job to its best orbit.', [
    { label: 'Weather watching', options: ['Geostationary orbit', 'Inside the atmosphere'], answer: 0 }, { label: 'Close Earth photos', options: ['Low Earth orbit', 'Far beyond the Moon'], answer: 0 }, { label: 'Crew research station', options: ['Low Earth orbit', 'Geostationary orbit'], answer: 0 }], 'Geostationary satellites hover over one spot; low orbits give detailed images and the ISS.'),
  L('mission', 5, 'Mission Builder: Grand tour', 'Plan an outer planets flyby.', [
    { label: 'Travel time to Jupiter', options: ['Years', 'Minutes'], answer: 0 }, { label: 'A gravity assist is used to', options: ['Gain speed from a planet', 'Slow a clock'], answer: 0 }, { label: 'Far from the Sun, probes use', options: ['Nuclear (RTG) power', 'Big solar sails only'], answer: 0 }], 'Probes like Voyager used gravity assists and RTGs.'),
  P('astro', 3, 'Match astronaut or pioneer with their first.', [['Yuri Gagarin', 'First human in space'], ['Neil Armstrong', 'First on the Moon'], ['Valentina Tereshkova', 'First woman in space'], ['Rakesh Sharma', 'First Indian in space']], 'All achieved major firsts.'),
  P('astron', 2, 'Match the celestial object to a short description.', [['Comet', 'Icy body with a tail'], ['Meteor', 'Streak of light'], ['Nebula', 'Cloud of gas and dust'], ['Black hole', 'Gravity so strong light cannot escape']], 'These objects are different types.'),
  M('astron', 5, 'Mystery! Clues: it orbits the Sun every ~76 years; has an icy nucleus; last seen from Earth in 1986. Which object?', 'Halley’s Comet', ['Hale–Bopp', 'Ceres', 'Haumea'], 'Halley’s Comet returns next in 2061.', { clues: ['Orbit ~76 years', 'Icy nucleus', 'Last visible in 1986'] }),
];
export const gen = {};
export const alt = {};
export const boss = { title: 'The Black Hole Boss', desc: 'Complete a planetary exploration mission to unlock new galaxies!', count: 5, minD: 3, cats: ['mission', 'planet', 'sat', 'astron', 'solar'], types: ['lab', 'order', 'mcq'] };
export const titles = ['Launch Pad', 'Solar System Station', 'Planet Parade', 'Star Cluster', 'Galaxy Gateway', 'Astronaut Academy', 'Mission Control', 'Satellite Swarm', 'Telescope Tower', 'Nebula Nexus'];
