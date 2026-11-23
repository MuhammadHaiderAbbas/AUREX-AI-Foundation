"""A small, explicitly FICTIONAL sample corpus for demos and tests.

Company names, institutions and figures are invented. Every document is stored with
is_sample=True, a "[Sample]" title prefix and source "AUREX sample corpus (fictional)",
and the UI labels it. Never present these as real market information.
"""

from datetime import timedelta

SOURCE = "AUREX sample corpus (fictional)"

# (title, doc_type, age, text)
SAMPLES: list[tuple[str, str, timedelta, str]] = [
    ("[Sample] Northwind Robotics reports third-quarter results", "earnings", timedelta(days=12),
     """Northwind Robotics, a fictional industrial automation company, reported third-quarter revenue of 4.2 billion dollars, an increase of 18 percent year on year.

Operating margin improved to 21.5 percent from 18.9 percent a year earlier, driven by higher software subscription revenue and lower component costs.

Management raised full-year revenue guidance to between 16.4 and 16.8 billion dollars, citing strong order intake in logistics automation.

The company warned that supply constraints for specialised sensors could limit deliveries in the fourth quarter, and that inventory levels rose to 2.9 billion dollars."""),
    ("[Sample] Analyst note: Northwind Robotics inventory build-up raises questions", "analysis",
     timedelta(days=5),
     """A research note from a fictional brokerage argues that the inventory build-up at Northwind Robotics is a concern, with inventory days rising to 118 from 96 a year ago.

The analysts expect slowing order growth in the first half of next year as warehouse customers delay projects, and see downside risk to consensus margin forecasts.

They acknowledge that software revenue growth remains robust at 31 percent, which partly offsets weaker hardware demand."""),
    ("[Sample] Central bank of Fictonia holds policy rate at 4.25 percent", "central_bank",
     timedelta(days=20),
     """The monetary policy committee of the fictional Central Bank of Fictonia voted seven to two to hold the policy rate at 4.25 percent.

Headline inflation eased to 3.1 percent, but services inflation remained elevated at 4.6 percent, according to the committee statement.

Two members voted for a 25 basis points cut, arguing that the labour market is cooling faster than expected.

The committee said future decisions would depend on incoming data and that policy would need to remain restrictive for some time."""),
    ("[Sample] Fictonia labour market report: unemployment rises to 4.4 percent", "economic_data",
     timedelta(days=9),
     """The fictional Fictonia statistics office reported that the unemployment rate rose to 4.4 percent from 4.2 percent in the previous month.

Annual wage growth slowed to 3.8 percent from 4.3 percent, the weakest pace in two years.

Employment in manufacturing declined for a third consecutive month, while services employment was broadly flat."""),
    ("[Sample] FX desk note: euro supported by narrowing rate differentials", "analysis",
     timedelta(days=3),
     """In this fictional scenario written for the AUREX demo, a desk note argues that EUR/USD is supported by narrowing interest rate differentials between the two regions.

The note expects EUR/USD to trade higher if incoming inflation data continues to ease, but flags elevated volatility around central bank meetings as a key risk.

Positioning data in the scenario shows speculative accounts hold a modest net long euro position."""),
    ("[Sample] Crypto weekly: exchange outflows and stablecoin supply", "news", timedelta(days=2),
     """This is a fictional market commentary for the AUREX demo. It describes Bitcoin (BTC-USD) exchange balances falling for a fourth consecutive week, which the author interprets as reduced selling pressure.

The commentary notes that stablecoin supply increased by 2 percent over the week, a sign of inflows into digital asset markets in the scenario.

It also warns that funding rates on derivatives venues have risen, which could signal crowded positioning and higher volatility."""),
    ("[Sample] Northwind Robotics annual report extract: risk factors", "filing", timedelta(days=410),
     """Risk factors (fictional annual report extract). Northwind Robotics depends on a small number of suppliers for specialised sensors; a disruption could materially affect deliveries.

The company is exposed to currency movements because 46 percent of revenue is earned outside its home market.

Customer concentration is significant: the five largest customers represented 38 percent of revenue in the fiscal year."""),
]
