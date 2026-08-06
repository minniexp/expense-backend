-- Log the selected Chase alert(s) to the expense tracker, from macOS Mail.
--
-- Select one or more alerts in Mail and run it. Multi-select works, so a backlog clears in one go.
--
-- ON REGULAR EXPRESSIONS IN APPLESCRIPT
--
-- The language has none. It can borrow Foundation's, which is what `use framework "Foundation"`
-- below is for, and NSRegularExpression is the same ICU engine the iPhone Shortcut's Match Text
-- actions run on. The patterns here are therefore character-for-character the ones on the phone,
-- and the two cannot drift apart in behaviour.
--
-- THE DATE is the date the message was received, not today. Running this over a three-week-old
-- alert with today's date would not merely be inaccurate: the date forms part of the row's
-- identity, so the same purchase would save a second time rather than update the first.
--
-- INSTALL
--   osacompile -o ~/Library/Scripts/Applications/Mail/"Log Selected Chase Alert.scpt" \
--     "Log Selected Chase Alert.applescript"
--   Script Editor ▸ Settings ▸ General ▸ "Show Script menu in menu bar".
--
-- THE TOKEN lives in the login Keychain, never in this file — this is version controlled, and a
-- credential committed to GitHub is a credential that has to be rotated. Store it once:
--   security add-generic-password -a "$USER" -s expense-ingest -w 'YOUR_INGEST_TOKEN'

use framework "Foundation"
use scripting additions

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------

property ENDPOINT : "https://expense-frontend-eosin.vercel.app/api/ingest/transaction"
property KEYCHAIN_SERVICE : "expense-ingest"

-- Zelle transfers and payroll deposits both settle against the checking account. Stated here
-- rather than parsed, because those emails never mention a card.
property CHECKING_LAST4 : "8837"
property PAYROLL_MERCHANT : "Direct Deposit - Payroll (UCC)"

-- Each pattern is anchored on the label Chase prints beside the value, not on position. That is
-- what lets one pattern work whether the body is plain text or HTML with the tags still in it, and
-- it is why the amount cannot be caught out by the "$0.00 level you set" line at the foot of every
-- card alert — that sentence has no `Amount` label in front of it.
property P_AMOUNT : "Amount(?:[ \\t]|<[^>]*>)*\\r?\\n?(?:[ \\t]|<[^>]*>)*\\$?([\\d,]+\\.\\d{2})"
property P_MERCHANT : "Merchant(?:[ \\t]|<[^>]*>)*\\r?\\n?(?:[ \\t]|<[^>]*>)*([^\\r\\n<]+)"
property P_LAST4 : "\\(\\.\\.\\.\\s?(\\d{4})\\)"
-- Names are not always shouted: "SHARON LEE" and "Adam Lui" are both real senders, so this
-- cannot require capitals beyond the first letter. Anchored to the start of a line, because
-- without that a body reading "Zelle payment Adam Lui sent you money" would capture the word
-- "payment" as part of the name.
property P_ZELLE_SENDER : "(?:\\n|^)[ \\t]*([A-Za-z][A-Za-z .'\\-]{1,60}?)[ \\t]+sent you money"
property P_MEMO : "Memo(?:[ \\t]|<[^>]*>)*\\r?\\n?(?:[ \\t]|<[^>]*>)*([^\\r\\n<]+)"

-- The date the transaction actually happened, which is not always the day the mail arrived.
--
-- Forwarding an alert gives the forward a fresh `date received`, so a July payment forwarded in
-- August would be dated August — and the date is part of the row's identity, so it would save as a
-- second transaction rather than matching the first. When the message states its own date, the body
-- knows better than the envelope.
--
-- Each alert type prints that date under its own label, so the label is what varies, not the shape:
--
--     Zelle          Sent on    Jul 11, 2026
--     direct deposit Posted     Jul 31, 2026 at 3:47 AM ET
--
-- The time and zone are optional in the capture because only some of them carry one, and the server
-- parses either form.
on datePatternFor(theLabel)
	return theLabel & "(?:[ \\t]|<[^>]*>)*\\r?\\n?(?:[ \\t]|<[^>]*>)*" & ¬
		"([A-Z][a-z]{2} \\d{1,2}, \\d{4}(?: at \\d{1,2}:\\d{2} ?[AP]M(?: [A-Z]{2,4})?)?)"
end datePatternFor

-- Empty means the message does not state a date of its own and the envelope is the best available.
-- Card alerts print one under "Date", but they arrive within seconds of the purchase, so the
-- received date is already right and reading the body would only add a way to be wrong.
on dateLabelFor(theRoute)
	if theRoute is "Zelle received" then return "Sent on"
	if theRoute is "payroll deposit" then return "Posted"
	return ""
end dateLabelFor

-- Routes dated when they are processed rather than when the transaction happened.
--
-- Mom's card is reconciled monthly against a return, so the day within the month is not what the
-- figure turns on. Worth knowing: this is the one route where forwarding an old alert, or clearing
-- a backlog, dates the row today rather than when the purchase was made.
on usesTodaysDate(theRoute)
	return theRoute is "mom card purchase"
end usesTodaysDate

property MONTH_ABBR : {"Jan", "Feb", "Mar", "Apr", "May", "Jun", ¬
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}

-- ---------------------------------------------------------------------------
-- Guards that apply to the RULE only
--
-- A rule is supposed to see each new message once. Two things break that, and both are ordinary:
-- clicking OK in Mail's Rules window offers to apply rules to everything already in the mailbox,
-- and a rule can be re-applied by hand. Either sweeps up mail that is not new at all.
--
-- Running the script by hand from the Script menu ignores both guards, because selecting a message
-- and choosing the script is an unambiguous instruction — that is how a backlog gets cleared.
-- ---------------------------------------------------------------------------

-- Older than this and a rule-triggered message is history being re-swept, not an alert arriving.
-- Generous rather than tight: `date received` is when the mail server got it, so a Mac that was
-- shut for a long weekend still fetches genuinely-unseen alerts dated several days back.
property MAX_AGE_DAYS : 3

-- Every message handled, by RFC Message-ID, so nothing is ever posted twice from a re-application.
property SEEN_FILE : "~/Library/Logs/expense-tracker-seen.txt"

on isRecent(d)
	return ((current date) - d) ≤ (MAX_AGE_DAYS * days)
end isRecent

on hasSeen(msgId)
	if msgId is missing value or msgId is "" then return false
	try
		-- -x -F: whole line, literal. A Message-ID contains characters a pattern would misread.
		do shell script "/usr/bin/grep -qxF " & quoted form of msgId & " " & SEEN_FILE
		return true
	on error
		return false
	end try
end hasSeen

on markSeen(msgId)
	if msgId is missing value or msgId is "" then return
	try
		do shell script "/bin/mkdir -p ~/Library/Logs && printf '%s\\n' " & ¬
			quoted form of msgId & " >> " & SEEN_FILE
	end try
end markSeen

-- Newest first. An insertion sort, because these lists are a handful of messages and the clarity
-- is worth more than the complexity of anything cleverer.
on sortNewestFirst(theList)
	set sorted to {}
	repeat with itemRef in theList
		set entry to contents of itemRef
		set placed to false
		set rebuilt to {}
		repeat with existingRef in sorted
			set existing to contents of existingRef
			if (not placed) and ((mReceived of entry) > (mReceived of existing)) then
				set end of rebuilt to entry
				set placed to true
			end if
			set end of rebuilt to existing
		end repeat
		if not placed then set end of rebuilt to entry
		set sorted to rebuilt
	end repeat
	return sorted
end sortNewestFirst

(*
 Recent alerts the mailbox holds, newest first, that have not been handled.

 The rule deliberately does NOT process the messages Mail hands it. Mail decides what to pass, and
 when rules are re-applied it works through the mailbox oldest-first — so a rule firing because a
 new alert arrived can be handed a message from last week instead. Asking the mailbox directly for
 what is both recent and unhandled makes the outcome depend on the mail, not on Mail's mood.

 Nothing is dropped: every unseen alert inside the window is returned, not merely the newest one.
 Taking only the latest would quietly lose the second of two alerts arriving together, and with
 the bank feed retired nothing else would ever reveal the gap.
*)
on recentUnhandledAlerts()
	set gathered to {}
	set cutoff to (current date) - (MAX_AGE_DAYS * days)

	tell application "Mail"
		repeat with acct in accounts
			try
				set msgs to (messages of mailbox "INBOX" of acct whose date received > cutoff)
				repeat with m in msgs
					set end of gathered to {mSubject:(subject of m), mBody:(content of m), ¬
						mReceived:(date received of m), mSender:(sender of m), mMsgId:(message id of m)}
				end repeat
			end try
		end repeat
	end tell

	set keep to {}
	repeat with itemRef in gathered
		set entry to contents of itemRef
		if (my routeFor(mSubject of entry)) is not "" and not (my hasSeen(mMsgId of entry)) then
			set end of keep to entry
		end if
	end repeat

	return my sortNewestFirst(keep)
end recentUnhandledAlerts

-- ---------------------------------------------------------------------------
-- Regular expressions, borrowed from Foundation
-- ---------------------------------------------------------------------------

on regexCapture(theText, thePattern)
	set nsText to current application's NSString's stringWithString:theText
	set theRegex to current application's NSRegularExpression's ¬
		regularExpressionWithPattern:thePattern options:0 |error|:(missing value)
	if theRegex is missing value then error "bad pattern: " & thePattern

	set theMatch to theRegex's firstMatchInString:nsText options:0 ¬
		range:{location:0, |length|:(nsText's |length|())}
	if theMatch is missing value then return missing value
	if (theMatch's numberOfRanges()) < 2 then return missing value

	set captured to (nsText's substringWithRange:(theMatch's rangeAtIndex:1)) as text
	return my trimmed(captured)
end regexCapture

on requiredCapture(theText, thePattern, theLabel)
	set found to my regexCapture(theText, thePattern)
	if found is missing value or found is "" then
		error "could not find the " & theLabel & " in this email"
	end if
	return found
end requiredCapture

on trimmed(t)
	set blanks to {" ", tab, return, linefeed}
	repeat while (length of t) > 0 and (character 1 of t) is in blanks
		set t to text 2 thru -1 of t
	end repeat
	repeat while (length of t) > 0 and (character -1 of t) is in blanks
		set t to text 1 thru -2 of t
	end repeat
	return t
end trimmed

-- ---------------------------------------------------------------------------
-- Routing — mirrors the Shortcut's subject conditions, in the same order.
-- AppleScript's `contains` ignores case unless told otherwise, which matches the /i on the phone.
-- ---------------------------------------------------------------------------

on routeFor(theSubject)
	-- Checked BEFORE the plain card rule. Chase writes the cardholder's name in front of the same
	-- "made a ... transaction" wording, so hers matches both and the more specific one must win.
	if (theSubject contains "KIM,JUNG SIN made a") and (theSubject contains "transaction") then
		return "mom card purchase"
	end if
	if (theSubject contains "You made a") and (theSubject contains "transaction") then
		return "card purchase"
	end if
	if theSubject contains "received money with Zelle" then return "Zelle received"
	-- Chase sends two subjects for one deposit, and payroll produces both every time:
	--     You have a direct deposit of $2,853.37
	--     Your $2,853.37 direct deposit posted to account ending in (...8837)
	-- Their bodies are identical in structure, so either can be parsed. Both are matched because
	-- which one arrives first is not predictable, and the duplicate check on the server means the
	-- second is recognised as already logged rather than saved twice.
	--
	-- Matched on these exact phrasings rather than a bare "direct deposit", which would also catch
	-- "Direct deposit is now easier than ever" and the university mailshots already in this inbox.
	if theSubject contains "You have a direct deposit" then return "payroll deposit"
	if theSubject contains "direct deposit posted to account" then return "payroll deposit"
	return ""
end routeFor

-- Returns {merchant, last4, txType} for the route, or errors with what was missing.
on fieldsFor(theRoute, theBody)
	if theRoute is "card purchase" then
		return {merchant:my requiredCapture(theBody, P_MERCHANT, "merchant"), ¬
			last4:my requiredCapture(theBody, P_LAST4, "card last four"), ¬
			txType:"expense"}

	else if theRoute is "mom card purchase" then
		-- The same body as any card alert; only whose card it was differs, and that is in the last
		-- four. "Mom - " goes in front so the ledger reads at a glance, but it is decoration: the
		-- server decides parents-monthly from card 8016, not from the words.
		return {merchant:"Mom - " & (my requiredCapture(theBody, P_MERCHANT, "merchant")), ¬
			last4:my requiredCapture(theBody, P_LAST4, "card last four"), ¬
			txType:"expense"}

	else if theRoute is "Zelle received" then
		set senderName to my requiredCapture(theBody, P_ZELLE_SENDER, "sender's name")
		set theMemo to my regexCapture(theBody, P_MEMO)

		-- "from" is load-bearing, not decoration. The server refuses a Zelle description saying
		-- neither from nor to, because a transfer is the one case where the same positive amount
		-- means the opposite thing half the time — it would file money received as money spent.
		set theMerchant to "Zelle from " & senderName
		if theMemo is not missing value and theMemo is not "" then
			set theMerchant to theMerchant & " / " & theMemo
		end if
		return {merchant:theMerchant, last4:CHECKING_LAST4, txType:"income"}

	else
		return {merchant:PAYROLL_MERCHANT, last4:CHECKING_LAST4, txType:"income"}
	end if
end fieldsFor

-- ---------------------------------------------------------------------------
-- Values
-- ---------------------------------------------------------------------------

-- Parsed through NSString rather than AppleScript's `as real`, which reads the decimal separator
-- from the system locale and would misread "168.00" wherever a comma is the separator.
on amountFrom(theBody)
	set raw to my requiredCapture(theBody, P_AMOUNT, "amount")
	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to ","
	set parts to text items of raw
	set AppleScript's text item delimiters to ""
	set cleaned to parts as text
	set AppleScript's text item delimiters to saved
	return ((current application's NSString's stringWithString:cleaned)'s doubleValue()) as real
end amountFrom

-- "Aug 1, 2026 at 8:33 AM" — the shape Chase writes its own dates in, which the server already
-- parses. Built from the date's parts rather than formatted, so it does not follow whatever locale
-- or 12/24-hour preference this Mac happens to have.
on chaseStyleDate(d)
	set y to year of d
	set monthIndex to (month of d) as integer
	set dd to day of d
	set hh to hours of d
	set mm to minutes of d

	set meridiem to "AM"
	if hh ≥ 12 then set meridiem to "PM"
	set hour12 to hh mod 12
	if hour12 = 0 then set hour12 to 12

	set mmText to (mm as text)
	if mm < 10 then set mmText to "0" & mmText

	return (item monthIndex of MONTH_ABBR) & " " & dd & ", " & y & ¬
		" at " & hour12 & ":" & mmText & " " & meridiem
end chaseStyleDate

on ingestToken()
	try
		return my trimmed(do shell script ¬
			"/usr/bin/security find-generic-password -s " & quoted form of KEYCHAIN_SERVICE & " -w")
	on error
		error "no ingest token in the Keychain. Store it once with:" & return & return & ¬
			"  security add-generic-password -a \"$USER\" -s " & KEYCHAIN_SERVICE & " -w 'YOUR_TOKEN'"
	end try
end ingestToken

-- ---------------------------------------------------------------------------
-- Posting
-- ---------------------------------------------------------------------------

-- Built and serialised through NSJSONSerialization rather than assembled by hand: a merchant name
-- is arbitrary text, and hand-written JSON is one apostrophe away from a malformed body.
on post(theAmount, theFields, theDateText, theToken)
	set payload to current application's NSMutableDictionary's dictionary()
	payload's setObject:(current application's NSNumber's numberWithDouble:theAmount) forKey:"Amount"
	payload's setObject:(merchant of theFields) forKey:"Merchant"
	payload's setObject:(last4 of theFields) forKey:"Last4"
	payload's setObject:(txType of theFields) forKey:"TransactionType"
	payload's setObject:theDateText forKey:"DateText"

	set jsonData to current application's NSJSONSerialization's ¬
		dataWithJSONObject:payload options:0 |error|:(missing value)
	if jsonData is missing value then error "could not encode the request"

	set tmpFile to do shell script "/usr/bin/mktemp /tmp/ingest.XXXXXXXX"
	try
		jsonData's writeToFile:tmpFile atomically:true

		-- The body goes to a file rather than onto the command line, so arbitrary merchant text
		-- never has to survive shell quoting.
		set raw to do shell script ¬
			"/usr/bin/curl -sS -X POST " & quoted form of ENDPOINT & ¬
			" -H 'Content-Type: application/json'" & ¬
			" -H " & quoted form of ("Authorization: Bearer " & theToken) & ¬
			" --data-binary @" & quoted form of tmpFile & ¬
			" -w '\\n%{http_code}'"
	on error errText
		do shell script "/bin/rm -f " & quoted form of tmpFile
		error errText
	end try
	do shell script "/bin/rm -f " & quoted form of tmpFile

	return my interpret(raw)
end post

-- Split curl's output into the JSON body and the status code appended by -w, then say what
-- happened. On failure prefer the backend's per-item messages — "Unknown card ...9999" names what
-- to fix, where the envelope only says nothing was saved.
on interpret(raw)
	set allLines to paragraphs of raw
	set statusText to item -1 of allLines

	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set bodyText to (items 1 thru -2 of allLines) as text
	set AppleScript's text item delimiters to saved

	set parsed to my parseJSON(bodyText)
	set statusCode to statusText as integer

	-- Returns {outKind, outText}. A duplicate and a save are both successes and both HTTP 2xx, so
	-- the caller cannot tell them apart from the status alone — but they mean different things in
	-- the log, and "saved already logged …" would read as neither.
	if statusCode ≥ 200 and statusCode < 300 then
		if parsed is not missing value then
			set dupes to (parsed's objectForKey:"duplicates")
			if dupes is not missing value and (dupes as integer) > 0 then
				set was to (parsed's objectForKey:"duplicateOf")
				if was is not missing value and (was's |count|()) > 0 then
					set t to (was's objectAtIndex:0)
					return {outKind:"duplicate", outText:((t's objectForKey:"date") as text) & "  " & ¬
						((t's objectForKey:"amount") as text) & "  " & ¬
						((t's objectForKey:"description") as text) & ¬
						"  (already logged, left untouched)"}
				end if
				return {outKind:"duplicate", outText:"already logged"}
			end if

			set txs to (parsed's objectForKey:"transactions")
			if txs is not missing value and (txs's |count|()) > 0 then
				set t to (txs's objectAtIndex:0)
				return {outKind:"saved", outText:((t's objectForKey:"date") as text) & "  " & ¬
					((t's objectForKey:"transactionType") as text) & "  " & ¬
					((t's objectForKey:"amount") as text) & "  " & ¬
					((t's objectForKey:"description") as text)}
			end if
		end if
		return {outKind:"saved", outText:"saved"}
	end if

	if parsed is not missing value then
		set errs to (parsed's objectForKey:"errors")
		if errs is not missing value and (errs's |count|()) > 0 then
			set messages to {}
			repeat with i from 0 to ((errs's |count|()) - 1)
				set end of messages to (((errs's objectAtIndex:i)'s objectForKey:"message") as text)
			end repeat
			set saved2 to AppleScript's text item delimiters
			set AppleScript's text item delimiters to "; "
			set joined to messages as text
			set AppleScript's text item delimiters to saved2
			error joined
		end if
		set envelope to (parsed's objectForKey:"error")
		if envelope is missing value then set envelope to (parsed's objectForKey:"message")
		if envelope is not missing value then error (envelope as text)
	end if

	error "HTTP " & statusText
end interpret

on parseJSON(t)
	if t is "" then return missing value
	set nsData to (current application's NSString's stringWithString:t)'s ¬
		dataUsingEncoding:(current application's NSUTF8StringEncoding)
	return current application's NSJSONSerialization's ¬
		JSONObjectWithData:nsData options:0 |error|:(missing value)
end parseJSON

-- ---------------------------------------------------------------------------
-- Main
-- ---------------------------------------------------------------------------

-- Two ways in.
--
--   on run                         — the Script menu, on whatever you have selected.
--   perform mail action …          — a Mail rule, on whatever just arrived.
--
-- Both funnel into processMessages so there is one copy of the logic. They differ only in how they
-- report: a rule fires unattended, and a modal alert per incoming email would be intolerable.

on processMessages(collected, interactive)
	try
		set theToken to my ingestToken()
	on error errText
		my logLine("FAILED " & errText)
		my announce("Expense tracker", errText, true, interactive)
		return
	end try

	set savedRows to {}
	set duplicateRows to {}
	set skipped to {}
	set failed to {}

	repeat with entry in collected
		set theSubject to mSubject of entry
		set theRoute to my routeFor(theSubject)

		-- Every message says what it is and what happened to it, before any decision is acted on.
		-- Without this a skip is indistinguishable from a broken script — which is exactly how an
		-- afternoon went once.
		my logLine("MESSAGE  subject=[" & theSubject & "]  len=" & (length of theSubject) & ¬
			"  from=[" & (mSender of entry) & "]  received=[" & ((mReceived of entry) as text) & "]")
		my logLine("FILTER   \"You made a\"=" & (theSubject contains "You made a") & ¬
			"  \"transaction\"=" & (theSubject contains "transaction") & ¬
			"  \"received money with Zelle\"=" & (theSubject contains "received money with Zelle") & ¬
			"  \"You have a direct deposit\"=" & (theSubject contains "You have a direct deposit") & ¬
			"  ->  route=[" & theRoute & "]")

		-- The rule's guards. Neither applies to a hand-run: choosing a message and running the
		-- script says plainly which message you meant, however old it is.
		set blockedBecause to ""
		if not interactive then
			if my hasSeen(mMsgId of entry) then
				set blockedBecause to "already handled once"
			else if not (my isRecent(mReceived of entry)) then
				set blockedBecause to "older than " & MAX_AGE_DAYS & " days — not a new arrival"
			end if
		end if

		if blockedBecause is not "" then
			my logLine("IGNORED  (" & blockedBecause & ")")
		else if theRoute is "" then
			set end of skipped to theSubject
			-- Recorded as handled: a subject that is not an alert will never become one, and
			-- without this every rule re-application logs the same non-alert again.
			my markSeen(mMsgId of entry)
		else
			try
				set theAmount to my amountFrom(mBody of entry)
				if theAmount = 0 then error "the amount came out as zero"
				set theFields to my fieldsFor(theRoute, mBody of entry)

				-- The envelope's date, unless the message states its own.
				set theDateText to my chaseStyleDate(mReceived of entry)
				set dateSource to "date received"
				set theDateLabel to my dateLabelFor(theRoute)
				if my usesTodaysDate(theRoute) then
					set theDateText to my chaseStyleDate(current date)
					set dateSource to "today"
				else if theDateLabel is not "" then
					set stated to my regexCapture(mBody of entry, my datePatternFor(theDateLabel))
					if stated is not missing value and stated is not "" then
						set theDateText to stated
						set dateSource to "\"" & theDateLabel & "\" in the body"
					end if
				end if

				my logLine("PARSED   amount=" & theAmount & "  merchant=[" & (merchant of theFields) & ¬
					"]  last4=[" & (last4 of theFields) & "]  type=" & (txType of theFields) & ¬
					"  dateText=[" & theDateText & "]  (from " & dateSource & ")")

				set outcome to my post(theAmount, theFields, theDateText, theToken)
				if (outKind of outcome) is "duplicate" then
					set end of duplicateRows to (outText of outcome)
				else
					set end of savedRows to (outText of outcome)
				end if
				my markSeen(mMsgId of entry)
			on error errText
				-- Deliberately NOT marked as handled. A failure is worth retrying; the server was
				-- unreachable, or a card is missing from the map and can be added.
				set end of failed to theRoute & ": " & errText
			end try
		end if
	end repeat

	my report(savedRows, duplicateRows, skipped, failed, interactive)
end processMessages

on run
	set collected to {}

	tell application "Mail"
		set sel to selection
		if (count of sel) = 0 then
			display alert "Nothing selected" message ¬
				"Select one or more Chase alerts in Mail, then run this again." as warning
			return
		end if
		-- Read everything out of Mail up front. Each property access is an Apple Event, and doing
		-- them inside the posting loop makes a ten-message run noticeably slow.
		repeat with m in sel
			set end of collected to {mSubject:(subject of m), mBody:(content of m), mReceived:(date received of m), mSender:(sender of m), mMsgId:(message id of m)}
		end repeat
	end tell

	-- Newest first here too, so a multi-select of a backlog logs in the order you would read it.
	-- Everything selected is still processed; the guards do not apply to a deliberate choice.
	my processMessages(my sortNewestFirst(collected), true)
end run

-- The Mail rule entry point. Mail hands the matched messages in directly; there is no selection.
using terms from application "Mail"
	on perform mail action with messages theMessages for rule theRule
		-- What Mail offers is noted, then set aside. During a rule re-application Mail works through
		-- the mailbox oldest-first, so the message it hands over when a new alert arrives is often
		-- something from last week. The mailbox itself is the better source.
		try
			tell application "Mail"
				set offered to (count of theMessages)
			end tell
		on error
			set offered to 0
		end try

		set found to my recentUnhandledAlerts()
		my logLine("TRIGGER  Mail offered " & offered & " message(s); found " & ¬
			(count of found) & " recent unhandled alert(s) in the mailbox, newest first")

		-- Only the newest is sent. The rule fires once per arriving message, so each alert gets its
		-- own turn at being newest and the queue drains as mail comes in.
		--
		-- The rest are named in the log rather than passed over in silence: they stay unhandled, and
		-- if no further mail arrives they will sit there until the next trigger or a manual run.
		set collected to {}
		if (count of found) > 0 then
			set collected to {item 1 of found}
			repeat with i from 2 to (count of found)
				set skippedEntry to item i of found
				my logLine("DEFERRED not the newest this trigger — [" & ¬
					(mSubject of skippedEntry) & "]  received=[" & ¬
					((mReceived of skippedEntry) as text) & "]")
			end repeat
		end if

		my processMessages(collected, false)
	end perform mail action with messages
end using terms from

-- Where a rule's failures go. A rule runs unattended, so a notification that is missed is a
-- transaction that silently never arrived — and with the bank feed retired there is no second
-- source that would ever reveal the gap. The log is the durable record.
property LOG_FILE : "~/Library/Logs/expense-tracker-ingest.log"

on logLine(theText)
	try
		do shell script "/bin/mkdir -p ~/Library/Logs && " & ¬
			"printf '%s %s\\n' \"$(/bin/date '+%Y-%m-%d %H:%M:%S')\" " & ¬
			quoted form of theText & " >> " & LOG_FILE
	end try
end logLine

-- One place that decides how to speak. Interactive runs get a dialog worth reading; a rule gets a
-- notification, because there is nobody there to click anything.
--
-- Deliberately does NOT log: callers log each outcome individually with its own prefix, and having
-- this log the combined summary too wrote every failure to the file twice.
on announce(theTitle, theMessage, isProblem, interactive)
	if interactive then
		if isProblem then
			display alert theTitle message theMessage as critical
		else
			display alert theTitle message theMessage
		end if
	else
		display notification theMessage with title theTitle
	end if
end announce

-- Every outcome goes to the log with its own prefix, so `grep DUPLICATE` and `grep FAILED` each
-- answer a question on their own. Written before anything is displayed: a notification can be
-- missed, and with the bank feed retired the log is the only durable record of what happened.
on writeLog(savedRows, duplicateRows, skipped, failed)
	repeat with s in savedRows
		my logLine("SAVED " & (s as text))
	end repeat
	repeat with s in duplicateRows
		my logLine("DUPLICATE " & (s as text))
	end repeat
	repeat with s in skipped
		my logLine("SKIPPED (not an alert) " & (s as text))
	end repeat
	repeat with f in failed
		my logLine("FAILED " & (f as text))
	end repeat
end writeLog

on joinLines(theList)
	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set out to theList as text
	set AppleScript's text item delimiters to saved
	return out
end joinLines

on report(savedRows, duplicateRows, skipped, failed, interactive)
	my writeLog(savedRows, duplicateRows, skipped, failed)

	-- Everything was ignored by the guards above. Staying silent is the point: a rule re-applied
	-- over a full mailbox should not fire a notification per message.
	if (count of savedRows) = 0 and (count of duplicateRows) = 0 ¬
		and (count of skipped) = 0 and (count of failed) = 0 then
		return
	end if

	-- A duplicate is not a problem: the transaction is in the ledger, which is what was wanted. It
	-- does not earn a dialog, only a mention.
	if (count of skipped) = 0 and (count of failed) = 0 then
		set counts to {}
		if (count of savedRows) > 0 then set end of counts to ((count of savedRows) as text) & " logged"
		if (count of duplicateRows) > 0 then ¬
			set end of counts to ((count of duplicateRows) as text) & " already logged"

		set saved to AppleScript's text item delimiters
		set AppleScript's text item delimiters to ", "
		set headline to counts as text
		set AppleScript's text item delimiters to saved

		display notification my joinLines(savedRows & duplicateRows) ¬
			with title "Expense tracker" subtitle headline
		return
	end if

	set msg to ""
	if (count of savedRows) > 0 then
		set msg to "Logged " & (count of savedRows) & ":" & return
		repeat with s in savedRows
			set msg to msg & "  " & s & return
		end repeat
		set msg to msg & return
	end if

	if (count of duplicateRows) > 0 then
		set msg to msg & "Already logged — left untouched:" & return
		repeat with s in duplicateRows
			set msg to msg & "  " & s & return
		end repeat
		set msg to msg & return
	end if

	if (count of skipped) > 0 then
		set msg to msg & "Not a recognised alert — nothing was sent:" & return
		repeat with s in skipped
			set msg to msg & "  • " & s & return
		end repeat
		set msg to msg & return
	end if

	if (count of failed) > 0 then
		set msg to msg & "Failed:" & return
		repeat with f in failed
			set msg to msg & "  • " & f & return
		end repeat
	end if

	my announce("Expense tracker", my trimmed(msg), ((count of failed) > 0), interactive)
end report
