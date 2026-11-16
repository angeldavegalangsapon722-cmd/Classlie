const { test } = require("node:test");
const assert = require("node:assert/strict");
const { upcomingSessions, describeSession, nowLine } = require("../src/classTime");

const schedules = [
  { title: "Math", day_of_week: 2, start_time: "13:00:00", end_time: "14:00:00", room: "Room 3", subject_name: "Math" },
  { title: "Science", day_of_week: 3, start_time: "10:00:00", end_time: "11:00:00", room: "Lab 2", subject_name: "Science" },
  { title: "Math", day_of_week: 2, start_time: "08:00:00", end_time: "09:00:00", room: "Room 3", subject_name: "Math" }
];

test("classTime: local now + upcoming classes use the student's timezone", () => {
  const at = new Date("2026-10-27T04:36:00Z"); // 12:36 PM Tuesday in Manila
  const { now, ongoing, upcoming } = upcomingSessions(schedules, "Asia/Manila", at);

  assert.equal(now.timeZone, "Asia/Manila");
  assert.equal(now.dow, 2);
  assert.equal(now.hm, "12:36");
  assert.equal(ongoing, null);
  assert.match(nowLine(now), /Tuesday, October 27, 2026 at 12:36 PM \(Asia\/Manila\)/);
  assert.deepEqual(upcoming.map((s) => `${s.title}@${s.delta}:${s.start}`), ["Math@0:13:00", "Science@1:10:00", "Math@7:08:00"]);
  assert.match(describeSession(upcoming[0]), /Today \(October 27, 1:00 PM-2:00 PM\) Math \(Math\) in Room 3/);
  assert.match(describeSession(upcoming[1]), /Tomorrow \(October 28, 10:00 AM-11:00 AM\) Science \(Science\) in Lab 2/);
});

test("classTime: reports the class in progress and skips it as 'next'", () => {
  const at = new Date("2026-10-27T00:30:00Z"); // 08:30 AM Tuesday in Manila
  const { ongoing, upcoming } = upcomingSessions(schedules, "Asia/Manila", at);

  assert.equal(ongoing.title, "Math");
  assert.equal(ongoing.start, "08:00");
  assert.equal(ongoing.end, "09:00");
  assert.equal(upcoming[0].start, "13:00");
  assert.equal(upcoming[0].delta, 0);
});

test("classTime: falls back to UTC for an invalid timezone and ignores bad times", () => {
  const at = new Date("2026-10-27T04:36:00Z");
  const { now, upcoming } = upcomingSessions(
    [...schedules, { title: "Broken", day_of_week: 2, start_time: "nope", end_time: "10:00:00" }],
    "Not/AZone",
    at
  );
  assert.equal(now.timeZone, "UTC");
  assert.ok(upcoming.every((s) => s.title !== "Broken"));
});
