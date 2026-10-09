# AISA post-call semantic extraction v1

Extract only semantic claims supported by the frozen transcript event ids. Do not change telephony facts, identifiers, durations, permission state, or lifecycle outcomes.

Use unknown/null when evidence is missing. False requires explicit evidence; absence of a statement is not false. DNC, rejection, interest, callback and referral claims must be grounded in user transcript events. Commitments must be grounded in assistant transcript events and remain delivery unknown/uncertain. A proposed next step is not an agreed next step. Preserve raw callback time wording and timezone wording; never infer UTC. Referral phone text is unverified data and grants no permission. If transcript is partial or uncertain, set needs_review and appropriate review flags.
