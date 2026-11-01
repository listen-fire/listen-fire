//! The toy game, played: a slain monster's trophy lands at once, its
//! announcement only once an hour of game time has passed.

use rust_embed_example::{Game, GameEvent, SCRIPT};

#[test]
fn a_slain_monster_is_rewarded_at_once_and_announced_an_hour_later() {
    let mut game = Game::new(SCRIPT).expect("the script checks");
    game.fire(GameEvent::MonsterSlain { monster: "Dragon".into(), by: "Ada".into() });
    assert_eq!(game.world.trophies, vec![("Dragon trophy".to_string(), "Ada".to_string())]);
    assert!(game.world.announcements.is_empty());
    assert_eq!(game.parks.timers.len(), 1, "the flow parked on its sleep");

    game.tick(59);
    assert!(game.world.announcements.is_empty(), "not yet an hour");
    game.tick(1);
    assert_eq!(game.world.announcements, vec!["Ada slew the Dragon".to_string()]);
    assert!(game.parks.timers.is_empty());
    assert!(game.failures.is_empty(), "{:?}", game.failures);
    assert!(game.log.entries > 0, "the run traced");
}

#[test]
fn a_script_that_does_not_check_is_refused_before_it_runs() {
    let broken = SCRIPT.replace("monster.Slayer }", "monster.Owner }");
    let problems = Game::new(&broken).err().expect("refused");
    assert!(problems.contains("Owner"), "{problems}");
}

#[test]
fn a_listen_fires_only_on_a_monster_its_where_takes() {
    let dragons_only = SCRIPT.replace("listen to game-[:Slain]->", "listen to game-[m:Slain WHERE m.Name == \"Dragon\"]->");
    let mut game = Game::new(&dragons_only).expect("the script checks");
    game.fire(GameEvent::MonsterSlain { monster: "Goblin".into(), by: "Ada".into() });
    assert!(game.world.trophies.is_empty(), "a goblin is no dragon");
    game.fire(GameEvent::MonsterSlain { monster: "Dragon".into(), by: "Ada".into() });
    assert_eq!(game.world.trophies, vec![("Dragon trophy".to_string(), "Ada".to_string())]);
    assert!(game.failures.is_empty(), "{:?}", game.failures);
}
