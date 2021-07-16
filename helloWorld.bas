REM Very basic demo of the QBasic implementation for Meritum
REM Uses all the advanced APIs
REM ---

DECLARE SUB PrintRainbow (text$)

SUB PrintRainbow (text$)
	Length = LEN(text$)
	FOR i = 1 TO Length
		COLOR i MOD 16
        PRINT MID$(text$, i, 1);
	NEXT i
	COLOR 0, 15
END SUB

FOR i = 1 TO 1024
	Color% = RND() * 16
	LOCATE 1, 1
	PRINT "C=";
	PRINT Color%, "     "
	GFILL RND() * 160, RND() * 300, RND() * 160, RND() * 300, Color%
NEXT i

LOCATE 1, 1

DIM Sprite AS INTEGER
Sprite = LOADIMAGE("test.png")
SPSET 1, Sprite
SPOFS 1, 0, 50
PrintRainbow "HELLO WORLD!"
PRINT ""
PRINT "Press ANY key"
SLEEP
PLAY "t200 o6 l8 e g > e c d g"
FOR i = 1 TO 100
	SPOFS 1, i, 50+i*2
	KeyPressed$ = INKEY$
	IF KeyPressed$ = (CHR$(0) + CHR$(27)) THEN
		PRINT "ESCAPE"
	END IF
	WAIT
NEXT i
SPCLR 1
PRINT "Enter your name:"
INPUT Name$
PRINT "HELLO " + Name$
SLEEP
PUTIMAGE Sprite, 0, 0
LOCATE 1, 1
PrintRainbow "GOOD BYE!       "
